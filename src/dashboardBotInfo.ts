/**
 * Bot Info online manual — HTML/CSS for the dashboard settings panel.
 * Feature lists come from buildBotInfoSnapshot(); prose shells from botInfoNarrative.
 */

import { renderBotInfoSectionArticles } from './botInfoNarrative';
import {
  botInfoChangelogClientPayload,
  BOT_INFO_CHANGELOG,
} from './botInfoChangelog';
import {
  buildBotInfoSnapshot,
  type BotInfoSnapshot,
} from './botInfoSnapshot';

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
      position: relative;
      flex: 0 0 auto; border: 1px solid #334155; background: #1e293b; color: #cbd5e1;
      font-size: 0.7rem; font-weight: 600; letter-spacing: 0.01em;
      padding: 0.4rem 0.7rem; border-radius: 9999px; cursor: pointer;
      transition: background .15s, border-color .15s, color .15s;
      min-height: 2rem;
      display: inline-flex; align-items: center; gap: 0.35rem;
    }
    .botinfo-chip:hover { border-color: #64748b; color: #f1f5f9; }
    .botinfo-chip.active {
      background: #064e3b; border-color: #059669; color: #a7f3d0;
    }
    .botinfo-chip:focus-visible {
      outline: 2px solid #34d399; outline-offset: 2px;
    }
    .botinfo-chip-badge {
      display: none;
      min-width: 1.05rem;
      height: 1.05rem;
      padding: 0 0.28rem;
      border-radius: 999px;
      background: #3b82f6;
      color: #eff6ff;
      font-size: 0.58rem;
      font-weight: 800;
      line-height: 1.05rem;
      text-align: center;
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.45);
    }
    .botinfo-chip-badge.is-on { display: inline-block; }
    .botinfo-whatsnew {
      margin: 0.65rem 0 0.2rem; padding: 0.65rem 0.75rem; border-radius: 10px;
      background: #0f172a; border: 1px solid #1e293b;
    }
    .botinfo-whatsnew h4 {
      margin: 0 0 0.4rem; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: #60a5fa;
    }
    .botinfo-whatsnew ul {
      margin: 0; padding-left: 1.05rem; font-size: 0.78rem; color: #94a3b8; line-height: 1.45;
    }
    .botinfo-whatsnew li { margin-bottom: 0.22rem; }
    .botinfo-whatsnew .botinfo-wn-ver {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.68rem; color: #93c5fd; margin-right: 0.25rem;
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
      display: grid; gap: 1px;
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
    .botinfo-matrix .hide-sm { }
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
    .botinfo-mod-groups { margin: 0 0 0.65rem; }
    .botinfo-mod-group {
      margin-bottom: 0.55rem; padding: 0.55rem 0.65rem; border-radius: 8px;
      background: #0f172a; border: 1px solid #334155;
    }
    .botinfo-mod-group-title {
      font-size: 0.72rem; font-weight: 700; color: #34d399; text-transform: uppercase;
      letter-spacing: 0.04em; margin-bottom: 0.35rem;
    }
    .botinfo-mod-group ul {
      margin: 0; padding-left: 1rem; font-size: 0.75rem; color: #94a3b8; line-height: 1.45;
    }
    .botinfo-mod-group li { margin-bottom: 0.22rem; }
    .botinfo-presets {
      display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0 0 0.65rem;
    }
    .botinfo-preset-chip {
      font-size: 0.68rem; color: #cbd5e1; background: #0f172a; border: 1px solid #334155;
      border-radius: 9999px; padding: 0.28rem 0.55rem; max-width: 100%;
    }
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
    .botinfo-where {
      margin: 0.35rem 0 0.75rem; padding: 0.5rem 0.7rem; border-radius: 8px;
      background: #0f172a88; border: 1px dashed #334155; font-size: 0.78rem; color: #94a3b8; line-height: 1.45;
    }
    .botinfo-where strong { color: #7dd3fc; font-weight: 600; }
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
      .botinfo-matrix .hide-sm { display: none; }
      .botinfo-card { padding: 0.85rem 0.8rem; scroll-margin-top: 3.5rem; }
      .botinfo-hero h2 { font-size: 1.05rem; }
    }
`;

/** Fixed chapter chips — add a shell in botInfoNarrative when adding a chapter. */
const SECTIONS: { id: string; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'modes', label: 'Modes' },
  { id: 'risk', label: 'Risk & Modules' },
  { id: 'microbots', label: 'Micro Bots' },
  { id: 'learning', label: 'Learning & ML' },
  { id: 'coaches', label: 'Coaches & Stack' },
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
      `<button type="button" class="botinfo-chip${i === 0 ? ' active' : ''}" data-botinfo-sec="${s.id}" onclick="showBotInfoSection('${s.id}')">` +
      `<span class="botinfo-chip-label">${esc(s.label)}</span>` +
      `<span class="botinfo-chip-badge" data-botinfo-badge="${s.id}" aria-hidden="true">0</span>` +
      `</button>`
  ).join('\n          ');
}

function whatsNewBlock(): string {
  const recent = BOT_INFO_CHANGELOG.slice(0, 4);
  if (!recent.length) return '';
  const lis = recent
    .map((e) => {
      const bullets = e.items
        .slice(0, 2)
        .map((t) => `<li><span class="botinfo-wn-ver">v${esc(e.version)}</span>${esc(t)}</li>`)
        .join('');
      return bullets;
    })
    .join('');
  return `<div class="botinfo-whatsnew" id="botinfo-whatsnew">
        <h4>What’s New</h4>
        <ul>${lis}</ul>
      </div>`;
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

function modesStrip(snap: BotInfoSnapshot): string {
  return `<div class="botinfo-modes">${snap.modes
    .map(
      (m) => `<div class="botinfo-mode ${esc(m.cssClass)}">
          <div class="t">${esc(m.label)}</div>
          <p>${esc(m.blurb)}</p>
        </div>`
    )
    .join('')}</div>`;
}

function learningMatrix(snap: BotInfoSnapshot): string {
  const mlCols = snap.mlLearnModes;
  const hideFrom = 2; // hybrid+ lead get hide-sm on narrow screens when ≥3 cols
  const colCount = 1 + mlCols.length;
  const cells: string[] = [];
  cells.push('<div class="hd">Heuristic \\ ML</div>');
  mlCols.forEach((ml, i) => {
    const hide = i >= hideFrom ? ' hide-sm' : '';
    cells.push(`<div class="hd${hide}">${esc(ml)}</div>`);
  });
  for (const h of snap.selfLearnModes) {
    cells.push(`<div class="row">${esc(h)}</div>`);
    mlCols.forEach((ml, i) => {
      const cell = snap.matrixCell[h][ml];
      const hide = i >= hideFrom ? ' hide-sm' : '';
      cells.push(
        `<div class="${esc(cell.tone)}${hide}">${esc(cell.label)}</div>`
      );
    });
  }
  return `<div class="botinfo-matrix" style="grid-template-columns: auto repeat(${mlCols.length}, 1fr)" role="table" aria-label="Learning and ML mode matrix">
        ${cells.join('\n        ')}
      </div>
      <p class="mint" style="margin:-0.35rem 0 0.65rem">On phones: open Micro Bots → Self-Learning for full controls. Matrix is generated from live mode enums.</p>`;
}

function profilesGrid(snap: BotInfoSnapshot): string {
  return `<div class="botinfo-profiles">${snap.profiles
    .map(
      (p) =>
        `<div class="botinfo-prof" style="border-left-color:${esc(p.color)}" title="${esc(p.style)}"><div class="n">${esc(p.name)}</div><div class="d">${esc(p.description)}</div></div>`
    )
    .join('')}</div>`;
}

function modulesByGroup(snap: BotInfoSnapshot): string {
  return `<div class="botinfo-mod-groups">${snap.moduleGroups
    .map(
      (g) => `<div class="botinfo-mod-group">
          <div class="botinfo-mod-group-title">${esc(g.label)} (${g.modules.length})</div>
          <ul>${g.modules
            .map(
              (m) =>
                `<li><strong>${esc(m.name)}</strong> — ${esc(m.description)}</li>`
            )
            .join('')}</ul>
        </div>`
    )
    .join('')}</div>`;
}

function presetsList(snap: BotInfoSnapshot): string {
  return `<div class="botinfo-presets">${snap.presets
    .map(
      (p) =>
        `<span class="botinfo-preset-chip" title="${esc(p.description)}">${esc(p.label)}</span>`
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
          <path d="M124 58 H168" stroke="#475569" stroke-width="2"/>
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
 * Full settings tab panel for the online manual (catalog-driven lists).
 */
export function buildBotInfoPanelHtml(
  versionLabel: string,
  snap: BotInfoSnapshot = buildBotInfoSnapshot()
): string {
  const label = versionLabel.startsWith('v') ? versionLabel : `v${versionLabel}`;
  const articles = renderBotInfoSectionArticles({
    snapshot: snap,
    profilesGrid: profilesGrid(snap),
    modulesByGroup: modulesByGroup(snap),
    presetsList: presetsList(snap),
    modesStrip: modesStrip(snap),
    learningMatrix: learningMatrix(snap),
    durabilityCards: durabilityCards(),
    overviewSvg: overviewSvg(),
    pipelineFlow: pipelineFlow(),
    whatsNew: whatsNewBlock(),
    openBtn,
  });

  const changelogJson = JSON.stringify(botInfoChangelogClientPayload()).replace(
    /</g,
    '\\u003c'
  );

  return `
    <!-- ========== TAB: Bot Info ========== -->
    <section data-tab-panel="botinfo" class="botinfo-panel hidden space-y-4" aria-label="Bot Info manual">
      <script type="application/json" id="botinfo-changelog-json">${changelogJson}</script>
      <div class="card" style="padding:1rem 1.1rem 0.5rem">
        <div class="botinfo-hero">
          <div>
            <h2>Bot Info <span class="sr-only">${esc(label)}</span></h2>
            <p class="botinfo-lede">Operator manual for this dashboard — ${snap.counts.profiles} micro-bots, ${snap.counts.modules} modules, ${snap.counts.presets} presets. Lists sync from code catalogs; use chips to jump. Blue chip counts mark unread What’s New items for that section.</p>
          </div>
          <span class="botinfo-ver" id="botinfo-panel-ver">${esc(label)}</span>
        </div>
        <nav class="botinfo-subnav" id="botinfo-subnav" aria-label="Bot Info sections">
          ${chipNav()}
        </nav>
      </div>
${articles}
    </section>
`;
}
