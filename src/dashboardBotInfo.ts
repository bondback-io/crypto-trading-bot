/**
 * Bot Info online manual — HTML/CSS for the dashboard settings panel.
 * Injected into DASHBOARD_HTML at module load with the current app version.
 */

export const BOT_INFO_CSS = `
    /* —— Bot Info manual —— */
    .botinfo-panel { max-width: 960px; }
    .botinfo-hero {
      display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between;
      gap: 0.85rem; margin-bottom: 0.75rem;
    }
    .botinfo-hero h2 {
      margin: 0; font-size: 1.15rem; font-weight: 700; letter-spacing: -0.02em; color: #f1f5f9;
    }
    .botinfo-hero .botinfo-ver {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.75rem; color: #34d399; background: #064e3b55; border: 1px solid #065f4633;
      padding: 0.2rem 0.55rem; border-radius: 9999px; white-space: nowrap;
    }
    .botinfo-lede {
      margin: 0.35rem 0 0; font-size: 0.875rem; color: #94a3b8; line-height: 1.5; max-width: 42rem;
    }
    .botinfo-subnav {
      position: sticky; top: 0; z-index: 20;
      display: flex; gap: 0.35rem; overflow-x: auto; -webkit-overflow-scrolling: touch;
      padding: 0.5rem 0 0.65rem; margin: 0 0 0.75rem;
      background: linear-gradient(180deg, var(--bg) 70%, transparent);
      scrollbar-width: thin;
    }
    .botinfo-subnav::-webkit-scrollbar { height: 4px; }
    .botinfo-chip {
      flex: 0 0 auto; border: 1px solid #334155; background: #1e293b; color: #cbd5e1;
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.01em;
      padding: 0.4rem 0.7rem; border-radius: 9999px; cursor: pointer;
      transition: background .15s, border-color .15s, color .15s;
      min-height: 2rem;
    }
    .botinfo-chip:hover { border-color: #64748b; color: #f1f5f9; }
    .botinfo-chip.active {
      background: #064e3b; border-color: #059669; color: #a7f3d0;
    }
    .botinfo-chip:focus-visible {
      outline: 2px solid #34d399; outline-offset: 2px;
    }
    .botinfo-card {
      background: #1e293b; border: 1px solid #334155; border-radius: 12px;
      padding: 1rem 1.1rem 1.15rem; margin-bottom: 0.85rem;
      scroll-margin-top: 3.25rem;
    }
    .botinfo-card h3 {
      margin: 0 0 0.45rem; font-size: 1rem; font-weight: 700; color: #f8fafc;
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
    }
    .botinfo-card h3 .botinfo-sec-num {
      font-size: 0.65rem; font-weight: 700; color: #34d399;
      background: #064e3b44; border: 1px solid #065f4644;
      padding: 0.12rem 0.4rem; border-radius: 6px;
    }
    .botinfo-card p {
      margin: 0 0 0.55rem; font-size: 0.84rem; color: #cbd5e1; line-height: 1.55;
    }
    .botinfo-card ul {
      margin: 0 0 0.65rem; padding-left: 1.15rem; font-size: 0.82rem; color: #94a3b8; line-height: 1.55;
    }
    .botinfo-card li { margin-bottom: 0.28rem; }
    .botinfo-card li strong { color: #e2e8f0; font-weight: 600; }
    .botinfo-actions {
      display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.35rem;
    }
    .botinfo-flow {
      display: flex; flex-wrap: wrap; align-items: stretch; gap: 0.4rem;
      margin: 0.75rem 0 0.85rem; padding: 0.75rem; border-radius: 10px;
      background: #0f172a; border: 1px solid #1e293b;
    }
    .botinfo-flow-step {
      flex: 1 1 5.5rem; min-width: 4.5rem; text-align: center;
      padding: 0.55rem 0.4rem; border-radius: 8px;
      background: #1e293b; border: 1px solid #334155;
    }
    .botinfo-flow-step .k {
      display: block; font-size: 0.65rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.04em; color: #34d399; margin-bottom: 0.2rem;
    }
    .botinfo-flow-step .v {
      display: block; font-size: 0.72rem; color: #94a3b8; line-height: 1.35;
    }
    .botinfo-flow-arrow {
      flex: 0 0 auto; align-self: center; color: #475569; font-size: 0.9rem;
      padding: 0 0.1rem; user-select: none;
    }
    .botinfo-modes {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;
      margin: 0.65rem 0 0.75rem;
    }
    .botinfo-mode {
      padding: 0.7rem 0.65rem; border-radius: 10px; border: 1px solid #334155; background: #0f172a;
    }
    .botinfo-mode .t {
      font-size: 0.78rem; font-weight: 700; margin-bottom: 0.3rem;
    }
    .botinfo-mode.paper .t { color: #94a3b8; }
    .botinfo-mode.livesim .t { color: #60a5fa; }
    .botinfo-mode.live .t { color: #f87171; }
    .botinfo-mode p {
      margin: 0; font-size: 0.72rem; color: #94a3b8; line-height: 1.4;
    }
    .botinfo-matrix {
      display: grid; grid-template-columns: auto repeat(4, 1fr); gap: 1px;
      background: #334155; border: 1px solid #334155; border-radius: 8px;
      overflow: hidden; margin: 0.65rem 0 0.75rem; font-size: 0.68rem;
    }
    .botinfo-matrix > div {
      background: #0f172a; padding: 0.45rem 0.4rem; text-align: center; color: #94a3b8;
    }
    .botinfo-matrix .hd { background: #1e293b; color: #e2e8f0; font-weight: 700; }
    .botinfo-matrix .row { text-align: left; font-weight: 600; color: #cbd5e1; }
    .botinfo-matrix .ok { color: #34d399; }
    .botinfo-matrix .warn { color: #fbbf24; }
    .botinfo-matrix .off { color: #64748b; }
    .botinfo-profiles {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr)); gap: 0.45rem;
      margin: 0.55rem 0 0.7rem;
    }
    .botinfo-prof {
      padding: 0.55rem 0.6rem; border-radius: 8px; background: #0f172a;
      border: 1px solid #334155; border-left-width: 3px;
    }
    .botinfo-prof .n { font-size: 0.78rem; font-weight: 700; color: #e2e8f0; margin-bottom: 0.15rem; }
    .botinfo-prof .d { font-size: 0.68rem; color: #94a3b8; line-height: 1.35; }
    .botinfo-durability {
      display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin: 0.65rem 0;
    }
    .botinfo-dur-card {
      padding: 0.65rem 0.7rem; border-radius: 8px; background: #0f172a; border: 1px solid #334155;
    }
    .botinfo-dur-card.good { border-color: #065f46; }
    .botinfo-dur-card.risk { border-color: #7f1d1d; }
    .botinfo-dur-card .t { font-size: 0.75rem; font-weight: 700; margin-bottom: 0.25rem; }
    .botinfo-dur-card.good .t { color: #34d399; }
    .botinfo-dur-card.risk .t { color: #f87171; }
    .botinfo-dur-card p { margin: 0; font-size: 0.72rem; color: #94a3b8; line-height: 1.4; }
    .botinfo-callout {
      margin: 0.55rem 0 0.65rem; padding: 0.65rem 0.75rem; border-radius: 8px;
      background: #0f172a; border-left: 3px solid #34d399; font-size: 0.8rem; color: #94a3b8; line-height: 1.45;
    }
    .botinfo-callout strong { color: #a7f3d0; }
    .botinfo-svg-wrap {
      margin: 0.65rem 0 0.75rem; padding: 0.5rem; border-radius: 10px;
      background: #0f172a; border: 1px solid #1e293b; overflow-x: auto;
    }
    .botinfo-svg-wrap svg { display: block; width: 100%; max-width: 640px; height: auto; margin: 0 auto; }
    @media (max-width: 640px) {
      .botinfo-modes { grid-template-columns: 1fr; }
      .botinfo-durability { grid-template-columns: 1fr; }
      .botinfo-flow-arrow { display: none; }
      .botinfo-flow-step { flex: 1 1 calc(50% - 0.4rem); }
      .botinfo-matrix {
        grid-template-columns: auto repeat(2, 1fr);
        font-size: 0.62rem;
      }
      .botinfo-matrix .hide-sm { display: none; }
      .botinfo-card { padding: 0.85rem 0.8rem; scroll-margin-top: 3.5rem; }
      .botinfo-hero h2 { font-size: 1.05rem; }
    }
`;

const SECTIONS: { id: string; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'modes', label: 'Modes' },
  { id: 'risk', label: 'Risk & Modules' },
  { id: 'microbots', label: 'Micro Bots' },
  { id: 'learning', label: 'Learning & ML' },
  { id: 'scanners', label: 'Scanners' },
  { id: 'execution', label: 'Execution' },
  { id: 'zion', label: 'Zion' },
  { id: 'copy', label: 'Copy & Wallets' },
  { id: 'backtester', label: 'Backtester' },
  { id: 'alerts', label: 'Alerts' },
  { id: 'backup', label: 'Backup' },
  { id: 'knobs', label: 'Knobs' },
];

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chipNav(): string {
  return SECTIONS.map(
    (s, i) =>
      `<button type="button" class="botinfo-chip${i === 0 ? ' active' : ''}" data-botinfo-sec="${s.id}" onclick="showBotInfoSection('${s.id}')">${esc(s.label)}</button>`
  ).join('\n          ');
}

function openBtn(tab: string, label: string): string {
  return `<button type="button" class="btn btn-secondary text-xs" onclick="showTab('${tab}')">${esc(label)}</button>`;
}

function pipelineFlow(): string {
  const steps = [
    ['1', 'Signal', 'Copy wallet or scanner / Pump'],
    ['2', 'Filters', 'Risk floors, anti-rug, session'],
    ['3', 'Lane', 'Micro-bot profile wins'],
    ['4', 'Size', 'SOL size × conviction'],
    ['5', 'Execute', 'Paper · Live Sim · Live'],
  ];
  const parts: string[] = [];
  steps.forEach(([n, k, v], i) => {
    if (i > 0) parts.push('<span class="botinfo-flow-arrow" aria-hidden="true">→</span>');
    parts.push(
      `<div class="botinfo-flow-step"><span class="k">${n}. ${esc(k)}</span><span class="v">${esc(v)}</span></div>`
    );
  });
  return `<div class="botinfo-flow" role="img" aria-label="Trade pipeline from signal to execute">${parts.join('')}</div>`;
}

function modeStrip(): string {
  return `<div class="botinfo-modes">
        <div class="botinfo-mode paper">
          <div class="t">Paper</div>
          <p>Virtual fills. Optional live marks. Safest place to test sizing and exits — no real SOL.</p>
        </div>
        <div class="botinfo-mode livesim">
          <div class="t">Live Sim</div>
          <p>Same live filters and market path as Live, but a paper ledger only. Default training mode.</p>
        </div>
        <div class="botinfo-mode live">
          <div class="t">Live</div>
          <p>Real Jupiter swaps with your trading wallet. Confirm carefully — real funds move.</p>
        </div>
      </div>`;
}

function learningMatrix(): string {
  return `<div class="botinfo-matrix" role="table" aria-label="Learning and ML mode matrix">
        <div class="hd">Heuristic \\ ML</div>
        <div class="hd">off</div>
        <div class="hd">shadow</div>
        <div class="hd hide-sm">hybrid</div>
        <div class="hd hide-sm">lead</div>
        <div class="row">shadow</div>
        <div class="off">propose only</div>
        <div class="ok">advise + ML watch</div>
        <div class="warn hide-sm">blend ranks</div>
        <div class="warn hide-sm">ML ranks first</div>
        <div class="row">auto</div>
        <div class="ok">apply upgrades</div>
        <div class="ok">apply + ML advise</div>
        <div class="warn hide-sm">apply + blend</div>
        <div class="warn hide-sm">ML can lead deltas</div>
      </div>
      <p class="mint" style="margin:-0.35rem 0 0.65rem">On phones: open Micro Bots → Self-Learning for the full hybrid/lead controls. Matrix shows the idea: heuristics propose; ML ranks or leads tiny knob tweaks when enabled.</p>`;
}

function profileGrid(): string {
  const profiles: [string, string, string][] = [
    ['#94a3b8', 'Default', 'Global fallback when multi-profile is off or no lane wins'],
    ['#fbbf24', 'Scalper', 'Fast small-MC in/out with tight TP/SL'],
    ['#38bdf8', 'Dip Buyer', 'Fib/support dip after a strong run'],
    ['#a78bfa', 'Trend Rider', 'Longer holds on established tokens'],
    ['#34d399', 'Migration Sniper', 'Near-graduation curve scalp (~80%→95–98%)'],
    ['#4ade80', 'High Win-Rate', 'Very selective multi-TA entries'],
    ['#fb923c', 'Momentum Burst', 'Volume / buy-pressure bursts'],
    ['#2dd4bf', 'Steady Compounder', 'Small consistent gains'],
    ['#f472b6', 'Reversal Scalper', 'Wick / mean-reversion'],
    ['#60a5fa', 'Smart Money Mirror', 'Copy with quality confirmation'],
  ];
  return `<div class="botinfo-profiles">${profiles
    .map(
      ([c, n, d]) =>
        `<div class="botinfo-prof" style="border-left-color:${c}"><div class="n">${esc(n)}</div><div class="d">${esc(d)}</div></div>`
    )
    .join('')}</div>`;
}

function durabilityCards(): string {
  return `<div class="botinfo-durability">
        <div class="botinfo-dur-card good">
          <div class="t">Durable DATA_DIR</div>
          <p>Mounted disk / persistent volume. Settings, paper state, wallets, learning episodes, and notifications survive deploys.</p>
        </div>
        <div class="botinfo-dur-card risk">
          <div class="t">Ephemeral disk</div>
          <p>Common on free hosts. Code updates wipe local JSON. Use Backup Site + optional GitHub backup before deploys.</p>
        </div>
      </div>`;
}

function overviewSvg(): string {
  return `<div class="botinfo-svg-wrap" aria-hidden="true">
        <svg viewBox="0 0 640 160" xmlns="http://www.w3.org/2000/svg" role="img">
          <defs>
            <linearGradient id="biGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#064e3b"/>
              <stop offset="100%" stop-color="#0f172a"/>
            </linearGradient>
          </defs>
          <rect width="640" height="160" rx="12" fill="url(#biGrad)"/>
          <rect x="24" y="36" width="100" height="44" rx="8" fill="#1e293b" stroke="#334155"/>
          <text x="74" y="55" text-anchor="middle" fill="#34d399" font-size="11" font-family="system-ui,sans-serif" font-weight="700">Wallets</text>
          <text x="74" y="70" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="system-ui,sans-serif">Copy</text>
          <rect x="24" y="92" width="100" height="44" rx="8" fill="#1e293b" stroke="#334155"/>
          <text x="74" y="111" text-anchor="middle" fill="#34d399" font-size="11" font-family="system-ui,sans-serif" font-weight="700">Scanner</text>
          <text x="74" y="126" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="system-ui,sans-serif">Pump · TA</text>
          <path d="M124 58 H168" stroke="#475569" stroke-width="2" marker-end="url(#biArr)"/>
          <path d="M124 114 H168" stroke="#475569" stroke-width="2"/>
          <rect x="168" y="52" width="110" height="56" rx="8" fill="#1e293b" stroke="#059669"/>
          <text x="223" y="78" text-anchor="middle" fill="#a7f3d0" font-size="12" font-family="system-ui,sans-serif" font-weight="700">Engine</text>
          <text x="223" y="94" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="system-ui,sans-serif">filter · profile · size</text>
          <path d="M278 80 H320" stroke="#475569" stroke-width="2"/>
          <rect x="320" y="28" width="90" height="36" rx="8" fill="#1e293b" stroke="#334155"/>
          <text x="365" y="50" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="system-ui,sans-serif">Paper</text>
          <rect x="320" y="72" width="90" height="36" rx="8" fill="#1e293b" stroke="#3b82f6"/>
          <text x="365" y="94" text-anchor="middle" fill="#93c5fd" font-size="11" font-family="system-ui,sans-serif">Live Sim</text>
          <rect x="320" y="116" width="90" height="36" rx="8" fill="#1e293b" stroke="#ef4444"/>
          <text x="365" y="138" text-anchor="middle" fill="#fca5a5" font-size="11" font-family="system-ui,sans-serif">Live</text>
          <path d="M410 46 H448" stroke="#475569" stroke-width="1.5"/>
          <path d="M410 90 H448" stroke="#475569" stroke-width="1.5"/>
          <path d="M410 134 H448" stroke="#475569" stroke-width="1.5"/>
          <rect x="448" y="52" width="168" height="56" rx="8" fill="#1e293b" stroke="#334155"/>
          <text x="532" y="78" text-anchor="middle" fill="#e2e8f0" font-size="12" font-family="system-ui,sans-serif" font-weight="700">Positions · PnL</text>
          <text x="532" y="94" text-anchor="middle" fill="#94a3b8" font-size="9" font-family="system-ui,sans-serif">Overview · Trades · Alerts</text>
        </svg>
      </div>`;
}

/**
 * Cog-menu row: Bot Info vX.Y.Z (placed at bottom of settings dropdown).
 */
export function buildBotInfoMenuItemHtml(versionLabel: string): string {
  const label = versionLabel.startsWith('v') ? versionLabel : `v${versionLabel}`;
  return `<button type="button" role="menuitem" data-settings-tab="botinfo" onclick="showTab('botinfo')" title="Online manual — features, modules, modes, and how the bot pieces connect">
            <span class="settings-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M8 7h8M8 11h6"/></svg></span>
            <span>Bot Info <span id="botinfo-menu-ver" class="text-emerald-400/90 font-mono text-[10px]">${esc(label)}</span></span>
          </button>`;
}

/**
 * Full settings tab panel for the online manual.
 */
export function buildBotInfoPanelHtml(versionLabel: string): string {
  const label = versionLabel.startsWith('v') ? versionLabel : `v${versionLabel}`;
  return `
    <!-- ========== TAB: Bot Info ========== -->
    <section data-tab-panel="botinfo" class="botinfo-panel hidden space-y-4" aria-label="Bot Info manual">
      <div class="card" style="padding:1rem 1.1rem 0.5rem">
        <div class="botinfo-hero">
          <div>
            <h2>Bot Info <span class="sr-only">${esc(label)}</span></h2>
            <p class="botinfo-lede">Operator manual for this dashboard — modes, modules, micro-bots, learning, scanners, execution, and backup. Use the chips to jump; deep-link buttons open the live controls.</p>
          </div>
          <span class="botinfo-ver" id="botinfo-panel-ver">${esc(label)}</span>
        </div>
        <nav class="botinfo-subnav" id="botinfo-subnav" aria-label="Bot Info sections">
          ${chipNav()}
        </nav>
      </div>

      <article class="botinfo-card" id="botinfo-sec-overview" data-botinfo-section="overview">
        <h3><span class="botinfo-sec-num">01</span> How the pieces connect</h3>
        <p>This bot combines <strong>copy trading</strong> (tracked smart wallets), <strong>market scanners</strong> (Dex/GMGN/Birdeye + Pump.fun), and <strong>micro-bot trade profiles</strong> that compete for each entry. Risk recipes and strategy modules set global floors; profiles refine entry/exit style.</p>
        ${overviewSvg()}
        ${pipelineFlow()}
        <ul>
          <li><strong>Overview</strong> — equity, open positions, risk badge, active profiles.</li>
          <li><strong>Live Feed</strong> — scanner universe, Pump activity, sizing / re-entry watches.</li>
          <li><strong>Micro Bots</strong> — enable profiles, knobs, self-learning / ML.</li>
          <li><strong>Cog menu</strong> — Smart Wallets, Settings, Config, Backtester, Logs, Back Up, and this manual.</li>
        </ul>
        <div class="botinfo-actions">
          ${openBtn('overview', 'Open Overview')}
          ${openBtn('scanner', 'Open Live Feed')}
          ${openBtn('microbots', 'Open Micro Bots')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-modes" data-botinfo-section="modes">
        <h3><span class="botinfo-sec-num">02</span> Trading modes</h3>
        <p>Mode is set from the header (Paper / Live Sim / Live). It changes whether fills are virtual or real — not which wallets or scanners you follow.</p>
        ${modeStrip()}
        <ul>
          <li><strong>Paper</strong> — practice ledger; good for UI and exit logic without live filter pressure.</li>
          <li><strong>Live Simulation</strong> — recommended daily mode: live market data + live filters, zero real SOL.</li>
          <li><strong>Live</strong> — Jupiter execution path with MEV options; needs funded trading wallet keys on the server.</li>
        </ul>
        <div class="botinfo-callout"><strong>Tip:</strong> Equity on Overview = Available + Positions. Reset clears session stats for module tests; it does not change Risk or modules.</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-risk" data-botinfo-section="risk">
        <h3><span class="botinfo-sec-num">03</span> Risk On / Off &amp; strategy modules</h3>
        <p><strong>Risk On</strong> applies lean hard floors (liquidity, MC, holders, etc.) plus Copy/Scanner baseline. <strong>Risk Off</strong> is an ops soak: high entry volume, floors relaxed so you can collect signals — enable quality modules manually.</p>
        <ul>
          <li><strong>Settings tab</strong> — Risk toggle, named strategy presets (High Win-Rate, Balanced, Scalper Suite, …), module master ON/OFF by group (entry / filters / exit / risk / advanced).</li>
          <li><strong>Config tab</strong> — trade size, TP/SL, anti-rug, conviction, MEV, notifications.</li>
          <li>Modules are kill switches for subsystems (e.g. honeypot check, trailing stop, MEV). Profiles can require a subset when Smart Bot Profiles is on.</li>
        </ul>
        <div class="botinfo-actions">
          ${openBtn('settings', 'Open Settings')}
          ${openBtn('config', 'Open Config')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-microbots" data-botinfo-section="microbots">
        <h3><span class="botinfo-sec-num">04</span> Micro Bots (trade profiles)</h3>
        <p>When <strong>Smart Bot Profiles</strong> / multi-profile is enabled, eligible profiles score each signal; the winner stamps the trade (lane fight). Disabled profiles never enter. Default is the legacy global fallback.</p>
        ${profileGrid()}
        <ul>
          <li><strong>Watchlists</strong> — Dip setup watch and Graduation (migration) watch live on the Micro Bots tab.</li>
          <li><strong>Knobs</strong> — per-profile TP/SL/hold/size and match filters; Global TP override can force one TP style across bots.</li>
          <li>Lane decisions appear on Overview / Micro Bots so you can see why a profile won or skipped.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('microbots', 'Open Micro Bots')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-learning" data-botinfo-section="learning">
        <h3><span class="botinfo-sec-num">05</span> Self-learning &amp; ML</h3>
        <p>Closed trades become <strong>episodes</strong>. Heuristic learning proposes small knob upgrades from patterns. Optional tabular ML ranks or leads those proposals. Neither system invents new strategies — they nudge existing knobs within clamps.</p>
        ${learningMatrix()}
        <ul>
          <li><strong>Heuristic mode</strong> — <code>shadow</code> (propose only) or <code>auto</code> (apply upgrades). Level counts applied upgrades.</li>
          <li><strong>ML mode</strong> — <code>off</code> · <code>shadow</code> (advise) · <code>hybrid</code> (blend) · <code>lead</code> (ML ranks first). Prefer shadow until holdout looks healthy.</li>
          <li>Learning data lives under DATA_DIR; inspect the journal on the Back Up tab. Ephemeral disks lose progress on deploy.</li>
        </ul>
        <div class="botinfo-actions">
          ${openBtn('microbots', 'Open learning controls')}
          ${openBtn('backup', 'Open learning journal')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-scanners" data-botinfo-section="scanners">
        <h3><span class="botinfo-sec-num">06</span> Market scanners &amp; Pump.fun</h3>
        <p>The <strong>Live Feed</strong> tab is the market universe: autonomous scanner (Dex / GMGN / Birdeye + optional Jupiter trending), Pump.fun smart activity (early curve, near migration, migrations), playbooks, and re-entry watches.</p>
        <ul>
          <li><strong>Market Scanner</strong> — can buy without a wallet copy when TA / filters pass; often hybrid with copy convergence.</li>
          <li><strong>Pump.fun</strong> — bonding-curve progress, migration listener, Discover Pump SM for early smart money.</li>
          <li><strong>Regime / session</strong> — scanner can pause in risk-off; UTC Asia/EU/US session filter can block entries.</li>
          <li>Migrations and setup watches also surface on Overview.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('scanner', 'Open Live Feed')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-execution" data-botinfo-section="execution">
        <h3><span class="botinfo-sec-num">07</span> Jupiter, RPC &amp; MEV</h3>
        <p>Live buys/sells go through <strong>Jupiter</strong> swaps. Jupiter Tokens API also feeds organic score / trending for the scanner. Dual-lane RPC keeps trading/copy on a primary endpoint and Zion/KOL on a secondary with failover.</p>
        <ul>
          <li><strong>MEV / Jito</strong> — tip bundles and sandwich abort (live only; module <code>mev_protection</code>).</li>
          <li>Paper and Live Sim never send real swaps; they still use live marks when configured.</li>
          <li>Fund gate, denied mints, dead-token filters, and honeypot checks sit on the path before size/execute.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('config', 'Open Config (MEV / RPC)')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-zion" data-botinfo-section="zion">
        <h3><span class="botinfo-sec-num">08</span> Zion (KOL Token Scanner)</h3>
        <p>Zion is an isolated micro-bot: it watches KOL wallets and builds <strong>manual trade offers</strong>. It never auto-buys. You Place Trade from the offer modal (with optional email / sound).</p>
        <ul>
          <li>Knobs: min KOL wallets, MC band, size / TP / SL / trail defaults, auto-offer.</li>
          <li>Uses the secondary RPC lane so KOL scanning does not starve copy/trading.</li>
          <li>Separate from copy-monitor and market scanner entry paths.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('zion', 'Open Zion')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-copy" data-botinfo-section="copy">
        <h3><span class="botinfo-sec-num">09</span> Copy trading &amp; smart wallets</h3>
        <p>The monitor loop polls tracked wallets, scores quality, detects convergence / smart-money flow, then runs the same filter → profile → size path as scanner entries.</p>
        <ul>
          <li><strong>Smart Wallets</strong> — discover via Kolscan, GMGN, Birdeye, Dex, Axiom, Photon, BullX, Nansen, or paste manually.</li>
          <li><strong>Live trading wallets</strong> — main/burner slots; private keys stay on the server (env), never in backups.</li>
          <li>Pause in the header stops the monitor without shutting down the process.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('wallets', 'Open Smart Wallets')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backtester" data-botinfo-section="backtester">
        <h3><span class="botinfo-sec-num">10</span> Backtester</h3>
        <p>Replay historical launches with Live-Sim-style decisions and exits. Paper-only — no live capital. Compare KPIs to recent Live Sim runs; breakdowns by Risk On/Off and profile.</p>
        <ul>
          <li><strong>Smart Advisor</strong> — shadow proposals from BT results; does not auto-apply to live.</li>
          <li><strong>Risk Recipe Optimizer</strong> — bounded search for recipe tweaks; still manual apply.</li>
          <li>Match-live Strict and lookback settings control how close the replay is to current filters.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('backtester', 'Open Backtester')}</div>
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
          ${openBtn('config', 'Open Notifications')}
          ${openBtn('logs', 'Open Logs')}
        </div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-backup" data-botinfo-section="backup">
        <h3><span class="botinfo-sec-num">12</span> Backup &amp; persistence</h3>
        <p>Settings, wallets, paper balance, profile knobs, learning episodes, and notifications save as JSON under <code>DATA_DIR</code>. Auto-saves on config changes, imports, top-ups, and backtests.</p>
        ${durabilityCards()}
        <ul>
          <li><strong>Backup Site / Load</strong> — download or restore a stamped full-site JSON.</li>
          <li><strong>GitHub Backup</strong> — optional Contents API upload (<code>GITHUB_BACKUP_TOKEN</code>); auto interval; load is always manual.</li>
          <li><strong>Learning journal</strong> — episode / knobs / upgrade / micro saves with export CSV/JSON.</li>
          <li>Private keys are never included in backups.</li>
        </ul>
        <div class="botinfo-actions">${openBtn('backup', 'Open Back Up')}</div>
      </article>

      <article class="botinfo-card" id="botinfo-sec-knobs" data-botinfo-section="knobs">
        <h3><span class="botinfo-sec-num">13</span> High-impact knobs</h3>
        <p>Start here before fine-tuning individual micro-bots. Most controls have <code>?</code> tips on the live screens.</p>
        <ul>
          <li><strong>Mode + Risk On/Off</strong> — posture for the whole bot.</li>
          <li><strong>Base / Max trade SOL</strong> — hard size caps; risk &amp; conviction multipliers scale within them.</li>
          <li><strong>TP / SL + Profit Strategy</strong> — partial → recover → bag → trail lifecycle.</li>
          <li><strong>Max positions · daily loss · convergence · min conviction / wallet Q</strong>.</li>
          <li><strong>Hard floors</strong> — min liq / MC / holders / volume; pump.fun-only; anti-rug / honeypot / sniper.</li>
          <li><strong>Market Scanner enable + Require TA + Jupiter trending</strong>.</li>
          <li><strong>Smart Bot Profiles / Multi-profile / Global TP override</strong>.</li>
          <li><strong>MEV + Jito tip</strong> (Live only).</li>
        </ul>
        <div class="botinfo-callout"><strong>Safe loop:</strong> Live Sim → tune Micro Bots → Backtester check → Back Up → only then Live with small size.</div>
        <div class="botinfo-actions">
          ${openBtn('config', 'Open Config')}
          ${openBtn('settings', 'Open Settings')}
          ${openBtn('microbots', 'Open Micro Bots')}
        </div>
      </article>
    </section>
`;
}
