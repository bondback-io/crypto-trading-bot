/**
 * Dashboard HTML — served at /dashboard
 * Tabbed Tailwind UI (Overview / Trades / Signals / Scanner / Zion / Micro Bots / Settings; Smart Wallets / Config / Backtester / Logs via settings menu)
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Smart Money Copy Bot</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            panel: '#0f172a',
            card: '#1e293b',
            line: '#334155',
          }
        }
      }
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0b1220;
      --panel: #0f172a;
      --card: #1e293b;
      --line: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --green: #34d399;
      --red: #f87171;
      --blue: #60a5fa;
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .mint {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }
    .mint.bt-your-mc { color: var(--green); }
    /* Never let .mint shrink form controls */
    .mint input, .mint select, .mint textarea,
    label.mint input, label.mint select, label.mint textarea {
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif !important;
      font-size: 13px !important;
      color: var(--text) !important;
      line-height: 1.25 !important;
    }
    .log-entry { font-size: 12px; padding: 6px 0; border-bottom: 1px solid #1e293b; }
    .log-buy { color: #34d399; } .log-sell { color: #f87171; } .log-error { color: #f87171; }
    .log-info { color: #94a3b8; } .log-signal { color: #60a5fa; }
    .switch { position: relative; width: 44px; height: 24px; display: inline-block; flex-shrink: 0; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; cursor: pointer; inset: 0; background: #334155; border-radius: 9999px; transition: .2s; }
    .slider:before { content: ''; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: .2s; }
    .switch input:checked + .slider { background: #059669; }
    .switch input:checked + .slider:before { transform: translateX(20px); }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .dot-running { background: #34d399; box-shadow: 0 0 8px #34d399; animation: status-pulse 1.6s ease-in-out infinite; }
    .dot-paused { background: #fbbf24; }
    @keyframes status-pulse {
      0%, 100% { box-shadow: 0 0 4px #34d39988; opacity: 1; }
      50% { box-shadow: 0 0 10px #34d399; opacity: .85; }
    }
    .status-ico {
      width: 12px;
      height: 12px;
      flex-shrink: 0;
      display: inline-block;
      vertical-align: -1px;
    }
    .run-status {
      display: inline-flex;
      align-items: center;
      gap: .3rem;
      padding: 1px 7px 1px 4px;
      border-radius: 9999px;
      border: 1px solid #334155;
      background: #0f172a88;
      line-height: 1.2;
    }
    .run-status.run-running {
      border-color: rgba(52, 211, 153, .45);
      background: rgba(6, 78, 59, .35);
      color: #6ee7b7;
    }
    .run-status.run-paused {
      border-color: rgba(251, 191, 36, .45);
      background: rgba(120, 53, 15, .35);
      color: #fcd34d;
    }
    .run-status.run-stopped {
      border-color: rgba(248, 113, 113, .45);
      background: rgba(127, 29, 29, .35);
      color: #fca5a5;
    }
    .run-status #status-text { font-weight: 700; font-size: 0.75rem; }
    .badge.status-badge {
      display: inline-flex;
      align-items: center;
      gap: .28rem;
    }
    .badge.status-badge .status-ico { width: 11px; height: 11px; }
    .rpc-status {
      display: inline-flex;
      align-items: center;
      gap: .28rem;
    }
    .rpc-status.rpc-ok { color: #6ee7b7; }
    .rpc-status.rpc-bad { color: #fca5a5; }
    .rpc-status.rpc-unknown { color: #94a3b8; }
    .active-profile-extras {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: .35rem .45rem;
      margin-left: .15rem;
    }
    .active-profile-extras .run-status,
    .active-profile-extras .badge {
      font-size: 11px;
      padding: 2px 8px;
    }
    .active-profile-extras .status-ico { width: 11px; height: 11px; }
    .dot-stopped { background: #f87171; }
    .signal-light {
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 13px; font-weight: 600; color: #e2e8f0;
    }
    .signal-light .dot-live { background: #34d399; box-shadow: 0 0 8px #34d399; }
    .signal-light .dot-quiet { background: #fbbf24; box-shadow: 0 0 6px #fbbf2488; }
    .signal-light .dot-paused { background: #fbbf24; box-shadow: 0 0 6px #fbbf2488; }
    .signal-light .dot-off { background: #f87171; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
    .badge-paper { background: #1d4ed833; color: #93c5fd; }
    .badge-livesim { background: #0f766e55; color: #5eead4; }
    .badge-live { background: #7f1d1d55; color: #fca5a5; }
    .strict-badge,
    .risk-badge {
      display: inline-flex;
      align-items: center;
      gap: .28rem;
      vertical-align: middle;
      padding: 2px 9px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: .01em;
      border: 1px solid transparent;
      white-space: nowrap;
      line-height: 1.25;
    }
    .strict-badge svg,
    .risk-badge svg {
      width: 11px;
      height: 11px;
      flex-shrink: 0;
    }
    .strict-badge-off {
      background: #33415566;
      color: #cbd5e1;
      border-color: #475569;
    }
    .strict-badge-low {
      background: #1d4ed855;
      color: #93c5fd;
      border-color: #3b82f6;
    }
    .strict-badge-medium {
      background: #c2410c55;
      color: #fdba74;
      border-color: #fb923c;
    }
    .strict-badge-high {
      background: #7e22ce55;
      color: #e9d5ff;
      border-color: #c084fc;
    }
    .risk-badge-low {
      background: #05966955;
      color: #6ee7b7;
      border-color: #34d399;
    }
    .risk-badge-medium {
      background: #0e749055;
      color: #5eead4;
      border-color: #2dd4bf;
    }
    .risk-badge-high {
      background: #c2410c55;
      color: #fdba74;
      border-color: #fb923c;
    }
    .risk-badge-degen {
      background: linear-gradient(135deg, #7f1d1d66, #6b21a866);
      color: #fca5a5;
      border-color: #c084fc;
    }
    .strat-src-badge {
      display: inline-block;
      margin-left: 0.4rem;
      padding: 1px 7px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      vertical-align: middle;
      border: 1px solid transparent;
    }
    .strat-src-core {
      background: #0f172a;
      color: #93c5fd;
      border-color: #1d4ed8;
    }
    .strat-src-risk {
      background: #042f2e;
      color: #5eead4;
      border-color: #0f766e;
    }
    .strat-src-optional {
      background: #1e293b;
      color: #94a3b8;
      border-color: #475569;
    }
    .strat-src-custom {
      background: #422006;
      color: #fde68a;
      border-color: #b45309;
    }
    .strategy-recipe-banner {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.55rem 0.75rem;
      margin-top: 0.75rem;
      padding: 0.55rem 0.75rem;
      border-radius: 0.5rem;
      border: 1px solid #334155;
      background: #0b1220;
      font-size: 0.8rem;
      line-height: 1.4;
      min-width: 0;
      max-width: 100%;
      box-sizing: border-box;
    }
    .strategy-recipe-banner-copy {
      flex: 1 1 12rem;
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .strategy-recipe-banner-title {
      display: block;
      font-weight: 700;
      margin-bottom: 0.15rem;
    }
    .strategy-recipe-banner-detail {
      display: block;
      opacity: 0.92;
      font-size: 0.74rem;
      line-height: 1.4;
    }
    .strategy-recipe-banner .btn {
      flex: 0 0 auto;
      white-space: nowrap;
    }
    .strategy-recipe-banner.is-custom {
      border-color: #b45309;
      background: #1c1410;
      color: #fde68a;
    }
    .strategy-recipe-banner.is-synced {
      border-color: #0f766e;
      background: #042f2e;
      color: #99f6e4;
    }
    .strategy-control-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.5rem 0.75rem;
      min-width: 0;
    }
    .strategy-control-head-main {
      /* Grow horizontally on desktop; never use a large flex-basis — in
         column layout (mobile) a 14rem basis became ~224px empty vertical gap. */
      flex: 1 1 auto;
      min-width: min(100%, 12rem);
      max-width: calc(100% - 12rem);
    }
    .strategy-control-head-main > p {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .strategy-control-head-meta {
      flex: 0 0 auto;
      text-align: right;
      min-width: 0;
      max-width: 12rem;
      margin-left: auto;
      position: relative;
      align-self: flex-start;
    }
    .strategy-control-head-meta #strategies-profile {
      overflow-wrap: anywhere;
      word-break: break-word;
      max-width: 18rem;
      margin-left: auto;
    }
    .strategy-io-btns {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      align-items: center;
      margin-top: 0.35rem;
    }
    .strategy-io-btns .btn {
      padding: 0.28rem 0.55rem;
      font-size: 0.72rem;
      line-height: 1.2;
    }
    .strategy-io-status {
      font-size: 0.72rem;
      color: #94a3b8;
      margin-top: 0.25rem;
      min-height: 1em;
    }
    .strategy-io-status.is-ok { color: #6ee7b7; }
    .strategy-io-status.is-err { color: #fca5a5; }
    .strategies-count-hot {
      cursor: pointer;
      text-decoration: underline dotted rgba(148,163,184,.55);
      text-underline-offset: 3px;
    }
    .strategies-count-hot[aria-expanded="true"] {
      color: #f8fafc;
      text-decoration-color: rgba(248,250,252,.9);
    }
    .strategies-on-popover {
      position: absolute;
      right: 0;
      top: calc(100% + 6px);
      z-index: 40;
      width: min(20rem, 86vw);
      max-height: 16rem;
      overflow: auto;
      text-align: left;
      padding: 0.65rem 0.75rem;
      border-radius: 0.55rem;
      background: #0b1220;
      border: 1px solid #334155;
      box-shadow: 0 12px 28px rgba(2,6,23,.55);
      font-size: 12px;
      color: #cbd5e1;
    }
    .strategies-on-popover.hidden { display: none; }
    .strategies-on-popover .sop-title {
      font-weight: 600;
      color: #e2e8f0;
      margin-bottom: 0.4rem;
    }
    .strategies-on-popover .sop-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.28rem;
    }
    .strategies-on-popover .sop-list li {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .strategies-on-popover .sop-name { color: #f8fafc; }
    .strategies-on-popover .sop-badge {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .04em;
      color: #94a3b8;
      flex: 0 0 auto;
    }
    .strategies-on-popover .sop-empty { color: #94a3b8; }
    .strategy-control-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.45rem;
      margin-top: 0.5rem;
      min-width: 0;
    }
    .strategy-control-actions .btn {
      flex: 0 1 auto;
    }
    .active-profile-banner .strict-badge,
    .active-profile-banner .risk-badge {
      font-size: 12px;
      padding: 3px 10px;
    }
    .active-profile-banner .strict-badge svg,
    .active-profile-banner .risk-badge svg {
      width: 12px;
      height: 12px;
    }
    .active-profile-plus {
      color: #64748b;
      font-weight: 700;
      font-size: .95rem;
      line-height: 1;
      user-select: none;
    }
    .score-card { text-align: center; }
    .score-grade { font-size: 2.25rem; font-weight: 800; line-height: 1; }
    .score-num { font-size: 1.1rem; font-weight: 600; margin-top: 4px; }
    .score-tone-good { color: #34d399; }
    .score-tone-average { color: #fbbf24; }
    .score-tone-poor { color: #f87171; }
    .score-tone-neutral { color: #94a3b8; }
    .cmp-win { color: #34d399; font-weight: 600; }
    .cmp-lose { color: #f87171; }
    .cmp-tie { color: #94a3b8; }
    .bt-pnl-cell { line-height: 1.35; white-space: nowrap; }
    .bt-pnl-cell .bt-pnl-sol { font-weight: 700; font-size: 13px; }
    .bt-pnl-cell .bt-pnl-usd { font-size: 11px; opacity: 0.85; }
    .bt-pnl-cell .bt-pnl-pct { font-size: 11px; opacity: 0.9; }
    .bt-takes { display: flex; flex-wrap: wrap; gap: 4px; max-width: 220px; }
    .bt-chip {
      display: inline-block; padding: 1px 7px; border-radius: 9999px;
      font-size: 10px; font-weight: 600; letter-spacing: 0.01em;
      border: 1px solid transparent;
    }
    .bt-chip-partial { background: #1e3a5f88; color: #93c5fd; border-color: #3b82f655; }
    .bt-chip-initial { background: #14532d66; color: #86efac; border-color: #22c55e55; }
    .bt-chip-bag { background: #42200666; color: #fdba74; border-color: #f59e0b55; }
    .bt-chip-trail { background: #312e8166; color: #c4b5fd; border-color: #8b5cf655; }
    .bt-chip-tp { background: #064e3b66; color: #6ee7b7; border-color: #34d39955; }
    .bt-chip-sl { background: #450a0a66; color: #fca5a5; border-color: #ef444455; }
    .bt-chip-forced { background: #27272a88; color: #a1a1aa; border-color: #52525b55; }
    .bt-chip-other { background: #1e293b88; color: #94a3b8; border-color: #33415555; }
    .bt-path { font-size: 10px; color: var(--muted); margin-top: 3px; max-width: 220px; }
    #bt-results-table tbody tr.bt-row-win { background: linear-gradient(90deg, rgba(52,211,153,0.07), transparent 40%); }
    #bt-results-table tbody tr.bt-row-loss { background: linear-gradient(90deg, rgba(248,113,113,0.07), transparent 40%); }
    .field label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 4px; }
    .field .val { color: #60a5fa; font-weight: 600; }
    .field input[type=range] { width: 100%; }
    .chart-wrap { position: relative; height: 220px; width: 100%; max-width: 100%; min-width: 0; }
    .chart-wrap canvas { max-width: 100% !important; }
    .chart-empty { color: #64748b; font-size: 13px; padding: 32px 0; text-align: center; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #1e293b; vertical-align: middle; }
    th { color: #94a3b8; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }

    /* Form controls — cover typed + untyped inputs */
    input:not([type]),
    input[type="text"],
    input[type="search"],
    input[type="number"],
    input[type="email"],
    input[type="url"],
    input[type="password"],
    select,
    textarea {
      background: var(--panel);
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 0.5rem;
      padding: 0.45rem 0.65rem;
      font-size: 13px;
      font-family: inherit;
      line-height: 1.25;
      min-height: 2.1rem;
      outline: none;
      transition: border-color .15s, box-shadow .15s;
    }
    input:not([type]):focus,
    input[type="text"]:focus,
    input[type="search"]:focus,
    input[type="number"]:focus,
    select:focus,
    textarea:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    input::placeholder, textarea::placeholder { color: #64748b; opacity: 1; }
    input[type="number"] {
      -moz-appearance: textfield;
      appearance: textfield;
      min-width: 4.25rem;
      text-align: right;
    }
    input[type="number"]::-webkit-outer-spin-button,
    input[type="number"]::-webkit-inner-spin-button {
      -webkit-appearance: none;
      margin: 0;
    }
    select {
      cursor: pointer;
      padding-right: 1.75rem;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%9494a3' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.65rem center;
    }
    textarea { min-height: 4.5rem; resize: vertical; width: 100%; }
    input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      min-height: 0;
      accent-color: #059669;
      cursor: pointer;
      flex-shrink: 0;
    }
    input[type="range"] {
      min-height: 0;
      background: transparent;
      border: none;
      padding: 0;
      box-shadow: none;
    }

    /* Compact labeled control groups */
    .ctl {
      display: inline-flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;
    }
    .ctl > span {
      font-size: 11px;
      color: var(--muted);
      font-weight: 500;
      letter-spacing: .02em;
      white-space: nowrap;
    }
    .ctl input:not([type="checkbox"]):not([type="radio"]),
    .ctl select {
      width: 100%;
      min-width: 4.5rem;
    }
    .ctl input[type="checkbox"],
    .ctl input[type="radio"] {
      width: auto;
      min-width: 0;
      flex-shrink: 0;
      accent-color: #10b981;
    }
    .ctl-sm { width: 4.75rem; }
    .ctl-md { width: 5.75rem; }
    .ctl-lg { width: 7.5rem; }
    .ctl-check {
      display: inline-flex;
      flex-direction: row;
      align-items: center;
      gap: 0.4rem;
      padding-top: 0;
      color: var(--muted);
      font-size: 12px;
      white-space: normal;
      line-height: 1.3;
      min-width: 0;
      max-width: 100%;
    }
    .ctl-check input[type="checkbox"] {
      width: 1rem !important;
      height: 1rem;
      min-width: 1rem;
      max-width: 1rem;
      flex-shrink: 0;
      accent-color: #10b981;
    }
    .ctl-check > span {
      flex: 1 1 auto;
      min-width: 0;
      white-space: normal;
    }
    /* When ctl-check sits beside labeled fields in a form grid, align to field baseline */
    .filters-row > .ctl-check,
    .grid > .ctl.ctl-check {
      padding-top: 1.1rem;
    }
    .filters-row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.55rem 0.65rem;
    }
    .filters-row .search-q {
      flex: 1 1 220px;
      min-width: 180px;
    }

    .btn { display: inline-flex; align-items: center; gap: 0.35rem; border-radius: 0.5rem; padding: 0.45rem 0.75rem; font-size: 12px; font-weight: 600; border: 1px solid transparent; cursor: pointer; min-height: 2.1rem; }
    .btn-primary { background: #059669; color: white; }
    .btn-primary:hover { background: #047857; }
    .btn-secondary { background: #1e293b; color: #e2e8f0; border-color: #334155; }
    .btn-secondary:hover { background: #334155; }
    .btn-danger { background: #dc2626; color: white; }
    .btn-warning { background: #b45309; color: white; }
    button.danger { background: #dc2626; color: white; border-color: #dc2626; border-radius: 0.5rem; padding: 0.35rem 0.65rem; font-size: 12px; font-weight: 600; cursor: pointer; }
    button.secondary { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; border-radius: 0.5rem; padding: 0.35rem 0.65rem; font-size: 12px; font-weight: 600; cursor: pointer; }
    button.warning { background: #b45309; color: white; border-color: #b45309; border-radius: 0.5rem; padding: 0.35rem 0.65rem; font-size: 12px; font-weight: 600; cursor: pointer; }
    button:not(.btn):not(.danger):not(.secondary):not(.warning):not(.settings-btn):not([data-settings-tab]):not(.strategy-preset-btn):not(.closed-filter-btn):not(.nav-tab):not(.trade-group-toggle):not(.ca-btn):not(.tip) {
      background: #059669;
      color: white;
      border: 1px solid #059669;
      border-radius: 0.5rem;
      padding: 0.35rem 0.65rem;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1rem; }
    .config-panel > .grid,
    #strategies-grid { align-items: start; gap: 1rem; }
    .config-panel .card,
    .strategies-panel .card { min-width: 0; }
    .config-panel .section-title,
    .strategies-panel .section-title { margin-bottom: .7rem; }
    .config-panel .filters-row { row-gap: .7rem; }
    .config-wide-card { grid-column: 1 / -1; }
    .strategy-risk-card {
      border-color: rgba(16, 185, 129, .42);
      background: linear-gradient(135deg, rgba(16, 185, 129, .09), rgba(30, 41, 59, .98) 42%);
    }
    .strategy-risk-card #risk-level-toggle,
    .strategy-risk-card #strict-intensity-toggle { gap: .5rem; }
    .strategy-group-card { padding: .85rem 1rem; }
    .strategy-row { padding: .85rem 0; }
    .strategy-preset-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.35rem;
      margin-top: 0.55rem;
    }
    @media (min-width: 720px) {
      .strategy-preset-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.45rem 0.65rem;
      }
    }
    .strategy-preset-grid.short-term-presets {
      margin-top: 0.45rem;
      grid-template-columns: 1fr;
    }
    @media (min-width: 720px) {
      .strategy-preset-grid.short-term-presets {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    .strategy-preset-btn {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      text-align: left;
      width: 100%;
      border-radius: 0.55rem;
      border: 1px solid #334155;
      background: #0f172a;
      color: #e2e8f0;
      padding: 0.65rem 0.75rem;
      cursor: pointer;
      transition: border-color .15s ease, background .15s ease, box-shadow .15s ease;
      min-height: 0;
      --preset-accent: #34d399;
    }
    .strategy-preset-btn[data-accent="teal"] { --preset-accent: #2dd4bf; }
    .strategy-preset-btn[data-accent="orange"] { --preset-accent: #fb923c; }
    .strategy-preset-btn[data-accent="sky"] { --preset-accent: #38bdf8; }
    .strategy-preset-btn:hover {
      border-color: #475569;
      background: #111827;
    }
    .strategy-preset-btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .strategy-preset-btn .preset-copy {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      min-width: 0;
      flex: 1 1 auto;
    }
    .strategy-preset-btn .preset-label {
      display: block;
      font-size: 0.8rem;
      font-weight: 650;
      color: #f1f5f9;
      line-height: 1.3;
    }
    .strategy-preset-btn .preset-desc {
      display: block;
      font-size: 0.72rem;
      line-height: 1.4;
      color: #a8b4c4;
      font-weight: 500;
    }
    .strategy-preset-btn .preset-switch {
      position: relative;
      width: 2.5rem;
      height: 1.35rem;
      flex-shrink: 0;
      border-radius: 999px;
      background: #334155;
      border: 1px solid #475569;
      transition: background .15s ease, border-color .15s ease;
    }
    .strategy-preset-btn .preset-switch::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 1rem;
      height: 1rem;
      border-radius: 50%;
      background: #e2e8f0;
      transition: transform .15s ease;
      box-shadow: 0 1px 2px rgba(0,0,0,.35);
    }
    .strategy-preset-btn.active {
      border-color: var(--preset-accent) !important;
      background: #12202f !important;
      box-shadow: inset 3px 0 0 var(--preset-accent) !important;
      color: #f8fafc !important;
    }
    .strategy-preset-btn.active .preset-label {
      color: #f8fafc !important;
    }
    .strategy-preset-btn.active .preset-desc {
      color: #dbe4f0 !important;
    }
    .strategy-preset-btn.active .preset-switch {
      background: var(--preset-accent) !important;
      border-color: var(--preset-accent) !important;
    }
    .strategy-preset-btn.active .preset-switch::after {
      transform: translateX(1.05rem);
      background: #0f172a !important;
    }
    .strategy-preset-btn[data-accent="teal"].active {
      background: #0f2a2a !important;
    }
    .strategy-preset-btn[data-accent="orange"].active {
      background: #2a1810 !important;
    }
    .strategy-preset-btn[data-accent="sky"].active {
      background: #0f2130 !important;
    }
    .strategy-preset-btn:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--preset-accent) 70%, #fff);
      outline-offset: 2px;
    }
    .strat-pack-section-label {
      margin-top: 0.75rem;
      margin-bottom: 0.15rem;
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .strat-setup-guide {
      display: grid;
      gap: .45rem;
      margin-bottom: .85rem;
      padding: .65rem .75rem;
      border-radius: .65rem;
      border: 1px solid #1e293b;
      background: #0b1220;
    }
    .strat-setup-guide .sg-step {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: .45rem .65rem;
      align-items: start;
      font-size: .75rem;
      line-height: 1.35;
      color: #94a3b8;
      min-width: 0;
    }
    .strat-setup-guide .sg-step > span:last-child {
      min-width: 0;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .strat-setup-guide .sg-num {
      width: 1.35rem;
      height: 1.35rem;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: .68rem;
      font-weight: 800;
      color: #0f172a;
      background: #34d399;
      flex-shrink: 0;
    }
    .strat-setup-guide strong { color: #e2e8f0; font-weight: 650; }
    .strat-adv-pack {
      margin-top: .85rem;
      border: 1px solid #1e293b;
      border-radius: .65rem;
      background: #0b1220;
      padding: 0;
    }
    .strat-adv-pack > summary {
      cursor: pointer;
      list-style: none;
      padding: .65rem .75rem;
      font-size: .82rem;
      font-weight: 650;
      color: #cbd5e1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: .35rem;
    }
    .strat-adv-pack > summary::-webkit-details-marker { display: none; }
    .strat-adv-pack > summary::after {
      content: 'Show';
      font-size: .68rem;
      font-weight: 600;
      color: #64748b;
    }
    .strat-adv-pack[open] > summary::after { content: 'Hide'; }
    #module-tune-card {
      margin-top: 0.75rem;
      background: #0b1220;
      border: 1px solid #1e293b;
      border-radius: 0.65rem;
      padding: 0.75rem;
    }
    #module-tune-card > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      user-select: none;
    }
    #module-tune-card > summary::-webkit-details-marker { display: none; }
    #module-tune-card .module-tune-summary-main {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      min-width: 0;
    }
    #module-tune-card .module-tune-chevron {
      display: inline-block;
      font-size: 0.65rem;
      color: #94a3b8;
      transition: transform 0.15s ease;
    }
    #module-tune-card[open] .module-tune-chevron {
      transform: rotate(90deg);
      color: #34d399;
    }
    #module-tune-card[open] .module-tune-summary-main .mint {
      display: none;
    }
    #module-tune-card .module-tune-body {
      margin-top: 0.5rem;
      padding-top: 0.5rem;
      border-top: 1px solid #1e293b;
    }
    .strat-adv-pack .strat-adv-body {
      padding: 0 .75rem .75rem;
      border-top: 1px solid #1e293b;
    }
    .strat-adv-pack .strat-adv-hint {
      margin: 0 0 0.35rem;
      font-size: 0.74rem;
      line-height: 1.45;
      color: #94a3b8;
    }
    .strat-adv-pack .strat-adv-hint strong {
      color: #e2e8f0;
      font-weight: 650;
    }
    #scalper-suite-settings.is-hidden-suite { display: none !important; }
    @media (max-width: 639px) {
      .strategy-control-card {
        padding: 0.85rem 0.75rem;
        overflow-x: clip;
      }
      .strategy-control-card .tp-toggle-row {
        grid-template-columns: 1fr;
      }
      .strategy-control-head {
        flex-direction: column;
        align-items: stretch;
        gap: 0.35rem;
      }
      .strategy-control-head-main {
        flex: 0 0 auto;
        min-width: 0;
        width: 100%;
      }
      .strategy-control-head-meta {
        flex: 0 0 auto;
        text-align: left;
        width: 100%;
      }
      .strategy-control-head-meta #strategies-profile {
        margin-left: 0;
        max-width: none;
      }
      .strategy-io-btns {
        width: 100%;
      }
      .strategy-io-btns .btn {
        flex: 1 1 calc(50% - 0.2rem);
        min-width: 0;
        justify-content: center;
      }
      .strategy-recipe-banner {
        flex-direction: column;
        align-items: stretch;
        gap: 0.55rem;
        padding: 0.65rem 0.7rem;
      }
      .strategy-recipe-banner .btn {
        width: 100%;
        justify-content: center;
        white-space: normal;
      }
      .strategy-control-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.45rem;
      }
      .strategy-control-actions .btn {
        width: 100%;
        min-width: 0;
        justify-content: center;
        white-space: normal;
        line-height: 1.25;
        padding: 0.45rem 0.5rem;
      }
      .strat-setup-guide {
        padding: 0.55rem 0.65rem;
      }
      .strat-setup-guide .sg-step {
        font-size: 0.72rem;
        gap: 0.4rem 0.5rem;
      }
      .strategy-risk-card .btn {
        flex: 1 1 calc(50% - .35rem);
        min-width: 0;
        justify-content: center;
      }
    }
    .active-profile-banner {
      border-radius: .75rem;
      border: 1px solid #334155;
      padding: .85rem 1rem;
      background: linear-gradient(135deg, rgba(30, 41, 59, .98), rgba(15, 23, 42, .96));
      min-width: 0;
    }
    .active-profile-banner .active-profile-main {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: .35rem .65rem;
    }
    .active-profile-banner .active-profile-kicker {
      font-size: .72rem;
      font-weight: 700;
      letter-spacing: .04em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .active-profile-banner .active-profile-combo {
      display: none;
    }
    .active-profile-banner .active-profile-hint {
      margin: .4rem 0 0;
      font-size: .78rem;
      line-height: 1.4;
      color: #94a3b8;
    }
    .active-profile-banner.tone-low {
      border-color: rgba(16, 185, 129, .55);
      background: linear-gradient(135deg, rgba(16, 185, 129, .14), rgba(15, 23, 42, .96) 55%);
    }
    .active-profile-banner.tone-low .active-profile-combo { color: #6ee7b7; }
    .active-profile-banner.tone-medium {
      border-color: rgba(56, 189, 248, .45);
      background: linear-gradient(135deg, rgba(14, 165, 233, .12), rgba(15, 23, 42, .96) 55%);
    }
    .active-profile-banner.tone-medium .active-profile-combo { color: #7dd3fc; }
    .active-profile-banner.tone-high {
      border-color: rgba(251, 146, 60, .55);
      background: linear-gradient(135deg, rgba(249, 115, 22, .14), rgba(15, 23, 42, .96) 55%);
    }
    .active-profile-banner.tone-high .active-profile-combo { color: #fdba74; }
    .active-profile-banner.tone-degen {
      border-color: rgba(248, 113, 113, .55);
      background: linear-gradient(135deg, rgba(239, 68, 68, .16), rgba(88, 28, 135, .22) 45%, rgba(15, 23, 42, .96) 75%);
    }
    .active-profile-banner.tone-degen .active-profile-combo { color: #fca5a5; }
    .active-profile-banner.tone-off {
      border-color: rgba(100, 116, 139, .55);
      background: linear-gradient(135deg, rgba(71, 85, 105, .22), rgba(15, 23, 42, .96) 60%);
    }
    .active-profile-banner.tone-off .active-profile-combo { color: #cbd5e1; }
    @media (max-width: 639px) {
      .active-profile-banner { padding: .75rem .85rem; }
      .active-profile-plus { font-size: .85rem; }
    }
    .strategy-settings {
      margin-top: .65rem;
      border: 1px solid #334155;
      border-radius: .65rem;
      background: rgba(15, 23, 42, .72);
      overflow: hidden;
    }
    .strategy-settings summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: .75rem;
      padding: .55rem .7rem;
      color: #cbd5e1;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .strategy-settings summary::-webkit-details-marker { display: none; }
    .strategy-settings summary::after { content: '›'; color: #64748b; font-size: 18px; transform: rotate(90deg); transition: transform .15s; }
    .strategy-settings[open] summary::after { transform: rotate(-90deg); }
    .strategy-settings fieldset { border: 0; margin: 0; padding: .75rem; border-top: 1px solid #334155; min-width: 0; }
    .strategy-settings fieldset:disabled { opacity: .45; cursor: not-allowed; }
    .strategy-settings fieldset:disabled input,
    .strategy-settings fieldset:disabled select,
    .strategy-settings fieldset:disabled button { cursor: not-allowed; }
    /* One layout system for every strategy settings expander. */
    .strat-fields {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: .75rem;
      min-width: 0;
    }
    .strat-field {
      width: 100%;
      min-width: 0;
      max-width: none;
    }
    .strat-field.ctl {
      display: flex;
      gap: .35rem;
    }
    .strat-field > label,
    .strat-field > span {
      display: block;
      margin-bottom: .25rem;
      min-width: 0;
      white-space: normal;
      word-break: break-word;
      line-height: 1.35;
    }
    .strat-field input:not([type="checkbox"]),
    .strat-field select {
      width: 100%;
      min-width: 0;
    }
    .strat-check {
      grid-column: 1 / -1;
      display: flex;
      align-items: flex-start;
      width: 100%;
      min-width: 0;
      gap: .5rem;
      padding-top: 0;
      white-space: normal;
    }
    .strat-check.toggle-row { align-items: flex-start; }
    .strat-check > span:first-of-type {
      flex: 1 1 auto;
      width: auto;
      min-width: 0;
      white-space: normal;
      word-break: break-word;
      line-height: 1.4;
    }
    .strat-check > input[type="checkbox"] {
      flex: 0 0 auto;
      margin-top: .1rem;
    }
    .strat-check > .switch {
      flex: 0 0 auto;
      margin-left: auto;
    }
    .strat-slider {
      grid-column: 1 / -1;
    }
    #strategy-controls-wallet_convergence > [data-strategy-control="allowSingleWalletTopPerformerMigration"],
    #strategy-controls-wallet_convergence > [data-strategy-control="sel-require-convergence"],
    #strategy-controls-wallet_convergence > [data-strategy-control="sel-min-wallets"],
    #strategy-controls-wallet_convergence > [data-strategy-control="convergenceRequired"] {
      grid-column: 1 / -1;
    }
    [data-strategy-source-card="true"] { display: none !important; }
    @media (min-width: 640px) {
      .strat-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 640px) {
      .config-panel,
      .strategies-panel { gap: .75rem; }
      .config-panel .card,
      .strategies-panel .card { padding: .85rem; }
      .strategy-risk-card #risk-level-toggle .btn,
      .strategy-risk-card #strict-intensity-toggle .btn {
        flex: 1 1 calc(50% - .25rem);
        justify-content: center;
      }
      .strategy-settings summary { min-height: 42px; }
    }
    @media (min-width: 1024px) {
      .config-filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    .card-open-positions {
      position: relative;
      background:
        linear-gradient(135deg, rgba(16, 185, 129, 0.12) 0%, rgba(14, 165, 233, 0.06) 42%, rgba(30, 41, 59, 0.95) 100%),
        #1e293b;
      border: 1px solid rgba(52, 211, 153, 0.45);
      box-shadow:
        0 0 0 1px rgba(14, 165, 233, 0.12),
        0 10px 28px rgba(2, 6, 23, 0.45),
        inset 0 1px 0 rgba(148, 163, 184, 0.08);
      padding: 0.85rem 0.95rem 0.95rem;
      overflow: visible;
    }
    .card-open-positions::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      border-radius: 0.75rem 0 0 0.75rem;
      background: linear-gradient(180deg, #34d399, #38bdf8);
    }
    .card-closed-trades {
      position: relative;
      background:
        linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(30, 41, 59, 0.95) 55%),
        #1e293b;
      border: 1px solid rgba(56, 189, 248, 0.28);
      box-shadow:
        0 0 0 1px rgba(56, 189, 248, 0.08),
        0 8px 22px rgba(2, 6, 23, 0.4);
      padding: 0.85rem 0.95rem 0.95rem;
      overflow: visible;
    }
    .card-open-positions .section-title-open {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 0.55rem;
    }
    .card-open-positions .section-title-open .title-left {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .card-open-positions .section-title-open .title-text {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #ecfdf5;
    }
    .card-open-positions .pos-count-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.15rem 0.55rem;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 700;
      background: rgba(16, 185, 129, 0.18);
      border: 1px solid rgba(52, 211, 153, 0.4);
      color: #6ee7b7;
    }
    .card-open-positions .pos-count-badge[data-empty="1"] {
      background: rgba(71, 85, 105, 0.35);
      border-color: rgba(100, 116, 139, 0.45);
      color: #94a3b8;
    }
    .card-open-positions .title-right {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .card-open-positions .sell-all-btn[hidden] {
      display: none !important;
    }
    .card-open-positions .positions-scroll,
    .card-closed-trades .closed-trades-scroll {
      overflow-x: auto;
      overflow-y: auto;
      max-height: min(58vh, 40rem);
      border-radius: 0.5rem;
      border: 1px solid rgba(51, 65, 85, 0.7);
      background: rgba(15, 23, 42, 0.55);
      -webkit-overflow-scrolling: touch;
      scrollbar-gutter: stable;
    }
    .card-open-positions #positions-table,
    .card-open-positions #trades-positions-table,
    .card-closed-trades #closed-table,
    .card-closed-trades #trades-closed-table {
      min-width: 50rem;
      margin: 0;
      border-collapse: separate;
      border-spacing: 0;
    }
    .card-open-positions #positions-table thead th,
    .card-open-positions #trades-positions-table thead th,
    .card-closed-trades #closed-table thead th,
    .card-closed-trades #trades-closed-table thead th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: rgba(15, 23, 42, 0.98);
      color: #94a3b8;
      border-bottom: 1px solid rgba(71, 85, 105, 0.55);
      border-left: none;
      border-right: none;
      padding: 0.38rem 0.4rem;
      font-size: 0.65rem;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
      font-weight: 700;
    }
    .card-open-positions #positions-table tbody td,
    .card-open-positions #trades-positions-table tbody td,
    .card-closed-trades #closed-table tbody td,
    .card-closed-trades #trades-closed-table tbody td {
      padding: 0.4rem 0.4rem;
      border-bottom: 1px solid rgba(51, 65, 85, 0.35);
      border-left: none;
      border-right: none;
      vertical-align: middle;
      font-size: 0.78rem;
      line-height: 1.25;
    }
    .card-open-positions #positions-table tbody tr:hover,
    .card-open-positions #trades-positions-table tbody tr:hover,
    .card-closed-trades #closed-table tbody tr:hover,
    .card-closed-trades #trades-closed-table tbody tr:hover {
      background: rgba(56, 189, 248, 0.06);
    }
    .card-open-positions tr.pos-row-partial td {
      background: rgba(16, 185, 129, 0.07);
      border-top: 1px solid rgba(52, 211, 153, 0.18);
    }
    .card-open-positions tr.pos-row-partial:hover td {
      background: rgba(16, 185, 129, 0.11);
    }
    .card-open-positions tr.pos-row-trail td {
      box-shadow: inset 3px 0 0 rgba(167, 139, 250, 0.65);
    }
    /* Compact dense cells */
    .card-open-positions .pos-token-head { gap: 0.25rem 0.35rem; }
    .card-open-positions .pos-token-main .mint,
    .card-open-positions .pos-token-meta {
      font-size: 0.65rem !important;
      line-height: 1.2;
      margin-top: 0.1rem;
    }
    .card-open-positions .pos-status-row { margin-top: 0.2rem; gap: 0.2rem; }
    .card-open-positions .pos-status-badge {
      padding: 0.1rem 0.35rem;
      font-size: 8px;
    }
    .card-open-positions .pos-size-card,
    .card-open-positions .pos-pnl-cell {
      line-height: 1.2;
    }
    .card-open-positions .pos-size-label,
    .card-open-positions .pos-pnl-sub,
    .card-closed-trades .pos-pnl-sub {
      font-size: 0.65rem;
      color: #94a3b8;
    }
    .card-open-positions .pos-pnl-main,
    .card-closed-trades .pos-pnl-main {
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      font-size: 0.82rem;
    }
    .card-open-positions .mint-ca,
    .card-closed-trades .mint-ca {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.2rem;
    }
    .card-open-positions .mint-ca .ca-btn,
    .card-closed-trades .mint-ca .ca-btn,
    .card-open-positions .wallet-copy-cell .ca-btn,
    .card-closed-trades .wallet-copy-cell .ca-btn {
      padding: 0.05rem 0.3rem;
      font-size: 0.62rem;
      min-height: 0;
    }
    .card-open-positions .wallet-copy-cell { gap: 0.12rem; }
    .card-open-positions .trade-pnl-badge {
      width: 1.15rem;
      height: 1.15rem;
      font-size: 0.7rem;
    }
    .card-open-positions .trail-cell-compact {
      font-size: 0.72rem;
      white-space: nowrap;
      max-width: 9.5rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .card-open-positions .pos-tpsl-cell {
      font-size: 0.7rem;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      line-height: 1.2;
    }
    .card-open-positions .pos-more-info {
      display: inline-flex;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }
    .card-open-positions .pos-more-info-label {
      color: #38bdf8;
      font-size: 0.68rem;
      font-weight: 650;
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 2px;
      white-space: nowrap;
    }
    .card-open-positions .pos-more-info-label.is-empty {
      color: #64748b;
      font-weight: 500;
    }
    #pos-more-info-float {
      display: none;
      position: fixed;
      z-index: 80;
      max-width: min(22rem, calc(100vw - 1.25rem));
      max-height: min(70vh, 28rem);
      overflow: auto;
      padding: 0.65rem 0.75rem;
      border-radius: 10px;
      border: 1px solid rgba(56, 189, 248, 0.35);
      background: rgba(15, 23, 42, 0.98);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
      color: #cbd5e1;
      font-size: 0.72rem;
      line-height: 1.35;
    }
    #pos-more-info-float.is-open { display: block; }
    #pos-more-info-float.is-dual {
      max-width: min(44rem, calc(100vw - 1rem));
    }
    #pos-more-info-float .pmi-dual {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.75rem;
      align-items: start;
    }
    #pos-more-info-float .pmi-col {
      min-width: 0;
    }
    #pos-more-info-float .pmi-col-open {
      padding-right: 0.65rem;
      border-right: 1px solid rgba(148, 163, 184, 0.22);
    }
    #pos-more-info-float .pmi-col-exit .pmi-title {
      color: #fda4af;
    }
    #pos-more-info-float .pmi-title {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #7dd3fc;
      margin-bottom: 0.4rem;
    }
    #pos-more-info-float .pmi-score {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin-bottom: 0.45rem;
      padding: 0.2rem 0.45rem;
      border-radius: 999px;
      border: 1px solid rgba(52, 211, 153, 0.35);
      background: rgba(16, 185, 129, 0.1);
      color: #6ee7b7;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    #pos-more-info-float .pmi-score.is-mid {
      border-color: rgba(251, 191, 36, 0.4);
      background: rgba(251, 191, 36, 0.08);
      color: #fbbf24;
    }
    #pos-more-info-float .pmi-score.is-low {
      border-color: rgba(248, 113, 113, 0.4);
      background: rgba(248, 113, 113, 0.08);
      color: #fca5a5;
    }
    #pos-more-info-float .pmi-line {
      margin: 0.22rem 0;
      color: #94a3b8;
    }
    #pos-more-info-float .pmi-line strong {
      color: #e2e8f0;
      font-weight: 650;
    }
    #pos-more-info-float .pmi-empty {
      color: #94a3b8;
      font-style: italic;
    }
    .card-closed-trades .pos-more-info,
    .card-closed-trades .closed-more-info {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.15rem;
      cursor: pointer;
      user-select: none;
      max-width: 11rem;
    }
    .card-closed-trades .closed-reason-main {
      color: #cbd5e1;
      font-size: 0.72rem;
      line-height: 1.25;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      flex-wrap: wrap;
    }
    .card-closed-trades .pos-more-info-label {
      color: #38bdf8;
      font-size: 0.68rem;
      font-weight: 650;
      text-decoration: underline;
      text-decoration-style: dotted;
      text-underline-offset: 2px;
      white-space: nowrap;
    }
    .card-closed-trades .pos-more-info-label.is-empty {
      color: #64748b;
      font-weight: 500;
    }
    @media (max-width: 640px) {
      #pos-more-info-float .pmi-dual {
        grid-template-columns: 1fr;
      }
      #pos-more-info-float .pmi-col-open {
        padding-right: 0;
        padding-bottom: 0.55rem;
        border-right: none;
        border-bottom: 1px solid rgba(148, 163, 184, 0.22);
        margin-bottom: 0.35rem;
      }
    }
    .card-open-positions .open-profile-filter,
    .card-closed-trades .closed-profile-filter,
    .card-closed-trades .closed-filter {
      margin-bottom: 0.4rem !important;
    }
    .card-open-positions .closed-filter-btn,
    .card-closed-trades .closed-filter-btn {
      padding: 0.28rem 0.5rem;
      min-height: 1.65rem;
      font-size: 10px;
    }
    @media (min-width: 1024px) {
      .card-open-positions .positions-scroll,
      .card-closed-trades .closed-trades-scroll {
        max-height: min(62vh, 44rem);
      }
      .card-open-positions .pos-token-meta-extra {
        display: none; /* hide verbose liq/BE lines on desktop — still in title */
      }
    }
    @media (max-width: 639px) {
      .card-open-positions,
      .card-closed-trades {
        padding: 0.7rem 0.65rem 0.75rem;
      }
      .card-open-positions .positions-scroll,
      .card-closed-trades .closed-trades-scroll {
        max-height: min(70vh, 28rem);
      }
      .card-open-positions #positions-table,
      .card-open-positions #trades-positions-table,
      .card-closed-trades #closed-table,
      .card-closed-trades #trades-closed-table {
        min-width: 44rem;
      }
      .card-open-positions #positions-table tbody td,
      .card-open-positions #trades-positions-table tbody td,
      .card-closed-trades #closed-table tbody td,
      .card-closed-trades #trades-closed-table tbody td {
        padding: 0.45rem 0.35rem;
        font-size: 0.75rem;
      }
      .card-open-positions .sell-all-btn {
        min-height: 2.25rem;
        padding-left: 0.75rem;
        padding-right: 0.75rem;
      }
    }
    .positions-empty {
      text-align: center;
      padding: 1.75rem 1rem;
      color: #94a3b8;
    }
    .positions-empty strong {
      display: block;
      color: #e2e8f0;
      font-size: 14px;
      font-weight: 650;
      margin-bottom: 0.35rem;
    }
    .positions-empty span {
      font-size: 12px;
      color: #64748b;
    }
    .pos-token-head {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      gap: 0.3rem 0.4rem;
    }
    .pos-token-main {
      min-width: 0;
      flex: 1 1 7rem;
    }
    .pos-status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      margin-top: 0.35rem;
    }
    .pos-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      padding: 0.18rem 0.45rem;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.02em;
      line-height: 1.2;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .pos-status-badge.is-full {
      color: #cbd5e1;
      background: rgba(51, 65, 85, 0.55);
      border-color: rgba(100, 116, 139, 0.45);
    }
    .pos-status-badge.is-partial {
      color: #052e1c;
      background: #34d399;
      border-color: #6ee7b7;
    }
    .pos-status-badge.is-trail {
      color: #1e1b4b;
      background: #c4b5fd;
      border-color: #a78bfa;
    }
    .pos-status-badge.is-live {
      color: #0c4a6e;
      background: #7dd3fc;
      border-color: #38bdf8;
    }
    .exit-ico {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 0.95rem;
      height: 0.95rem;
      margin-right: 0.2rem;
      vertical-align: -0.12em;
      flex-shrink: 0;
    }
    .pos-status-badge .exit-ico {
      margin-right: 0;
      width: 0.85rem;
      height: 0.85rem;
    }
    .exit-ico svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .exit-ico.is-tp { color: #34d399; }
    .exit-ico.is-sl { color: #f87171; }
    .exit-ico.is-trail { color: #c4b5fd; }
    .exit-ico.is-timer { color: #7dd3fc; }
    .exit-ico.is-manual { color: #fbbf24; }
    .exit-ico.is-partial { color: #67e8f9; }
    .exit-ico.is-other { color: #94a3b8; }
    .closed-trades-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem 0.75rem;
      margin-bottom: 0.65rem;
    }
    .closed-trades-head .section-title {
      margin-bottom: 0;
    }
    .closed-filter {
      display: inline-flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      padding: 0;
      border-radius: 0;
      background: transparent;
      border: none;
    }
    .closed-filter-btn {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.25rem;
      border: 1px solid #334155;
      background: #1e293b;
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
      padding: 0.45rem 0.7rem;
      min-height: 2rem;
      border-radius: 0.45rem;
      cursor: pointer;
      -webkit-tap-highlight-color: transparent;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .closed-filter-btn:hover,
    .closed-filter-btn:focus-visible {
      color: #f8fafc;
      background: #334155;
      border-color: #64748b;
      outline: none;
    }
    .closed-filter-btn.is-active {
      color: #ecfdf5;
      background: rgba(16, 185, 129, 0.28);
      border-color: rgba(52, 211, 153, 0.65);
      font-weight: 700;
    }
    .closed-filter-btn.is-active[data-closed-filter="profit"] {
      color: #052e1c;
      background: #34d399;
      border-color: #6ee7b7;
    }
    .closed-filter-btn.is-active[data-closed-filter="loss"] {
      color: #450a0a;
      background: #f87171;
      border-color: #fca5a5;
    }
    .trade-profile-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-size: 0.72rem;
      font-weight: 700;
      padding: 0.2rem 0.5rem;
      border-radius: 0.4rem;
      border: 1.5px solid;
      white-space: nowrap;
      line-height: 1.25;
      letter-spacing: 0.01em;
      max-width: 11rem;
      vertical-align: middle;
      position: static;
      float: none;
      overflow: hidden;
      text-overflow: ellipsis;
      -webkit-text-fill-color: currentColor;
      box-sizing: border-box;
    }
    .trade-profile-badge .tpb-icon {
      font-size: 0.85rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .trade-profile-badge .tpb-name {
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    @media (max-width: 640px) {
      .trade-profile-badge {
        font-size: 0.7rem;
        padding: 0.22rem 0.45rem;
        gap: 0.25rem;
        max-width: 9rem;
      }
      .trade-profile-badge .tpb-icon { font-size: 0.8rem; }
    }
    td .trade-profile-badge {
      margin: 0;
    }
    /* Zion — apricot accent badge (aligned with Zion nav tab) */
    .trade-profile-badge.is-zion {
      color: #f2ae66 !important;
      border-color: rgba(242, 174, 102, 0.7) !important;
      background: rgba(242, 174, 102, 0.14) !important;
      box-shadow: none;
    }
    .zion-status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.68rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 0.15rem 0.45rem;
      border-radius: 999px;
      border: 1px solid transparent;
      line-height: 1.2;
    }
    .zion-status-pill.is-active {
      color: #5eead4;
      border-color: #2dd4bf66;
      background: #134e4a55;
    }
    .zion-status-pill.is-expired {
      color: #94a3b8;
      border-color: #47556988;
      background: #1e293b88;
    }
    .zion-status-pill.is-executed {
      color: #4ade80;
      border-color: #22c55e55;
      background: #14532d44;
    }
    .zion-status-pill.is-failed,
    .zion-status-pill.is-declined {
      color: #fca5a5;
      border-color: #ef444455;
      background: #7f1d1d33;
    }
    .zion-status-pill.is-approved {
      color: #fbbf24;
      border-color: #f59e0b55;
      background: #78350f33;
    }
    .zion-cand-card {
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 0.65rem 0.75rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #0f172a 0%, #111827 60%, #0b1220 100%);
      transition: border-color .18s ease, transform .18s ease, box-shadow .18s ease;
    }
    .zion-cand-card:hover {
      border-color: #334155;
      box-shadow: 0 8px 24px rgba(0,0,0,.28);
      transform: translateY(-1px);
    }
    .zion-cand-card.is-offered {
      border-color: #2dd4bf55;
      box-shadow: inset 0 0 0 1px #2dd4bf22;
    }
    .zion-cand-card.is-skipped {
      opacity: 0.72;
    }
    .zion-cand-sym {
      font-weight: 700;
      color: #f1f5f9;
      letter-spacing: 0.01em;
    }
    .zion-cand-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 0.55rem;
      margin-top: 0.35rem;
      font-size: 0.75rem;
      color: #94a3b8;
    }
    .zion-cand-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      padding: 0.1rem 0.4rem;
      border-radius: 6px;
      background: #1e293b99;
      border: 1px solid #33415566;
      color: #cbd5e1;
      font-size: 0.7rem;
    }
    .zion-cand-chip.is-score {
      color: #5eead4;
      border-color: #2dd4bf44;
    }
    .zion-cand-chip.is-boost {
      color: #fbbf24;
      border-color: #f59e0b44;
    }
    .zion-found-ago {
      font-size: 0.68rem;
      font-weight: 600;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      letter-spacing: 0.01em;
      line-height: 1.2;
    }
    .zion-cand-card .zion-found-ago,
    .zion-offer-row .zion-found-ago {
      margin-left: 0.35rem;
    }
    .zion-offer-row {
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 0.65rem 0.75rem;
      margin-bottom: 0.5rem;
      background: #0f172a;
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      justify-content: space-between;
    }
    .zion-open-row {
      border: 1px solid #1e293b;
      border-radius: 10px;
      padding: 0.65rem 0.75rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(90deg, #0f172a, #111827);
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 0.75rem;
      align-items: center;
      justify-content: space-between;
    }
    .zion-offer-stack {
      position: fixed;
      right: max(10px, env(safe-area-inset-right, 0px));
      bottom: max(10px, env(safe-area-inset-bottom, 0px));
      left: auto;
      top: auto;
      z-index: 1200;
      display: flex;
      flex-direction: column;
      justify-content: flex-end;
      align-items: stretch;
      gap: 10px;
      width: min(420px, calc(100vw - 20px));
      max-height: calc(100dvh - 16px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
      max-height: calc(100vh - 16px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
      overflow-x: hidden;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      pointer-events: none;
      padding: 2px 2px 4px;
      scrollbar-gutter: stable;
    }
    .zion-offer-stack[data-count="1"] .zion-offer-card {
      max-height: min(88dvh, 720px);
    }
    .zion-offer-stack[data-count="2"] .zion-offer-card {
      max-height: min(46dvh, 420px);
    }
    .zion-offer-stack[data-count="3"] .zion-offer-card,
    .zion-offer-stack[data-count="4"] .zion-offer-card,
    .zion-offer-stack[data-count="5"] .zion-offer-card {
      max-height: min(32dvh, 340px);
    }
    .zion-offer-card {
      pointer-events: auto;
      position: relative;
      flex: 0 0 auto;
      width: 100%;
      box-sizing: border-box;
      background: linear-gradient(160deg, #0b1220 0%, #0f172a 45%, #111827 100%);
      border: 1px solid #2dd4bf66;
      border-radius: 14px;
      padding: 12px 14px 10px;
      box-shadow: 0 18px 48px rgba(0,0,0,.55), 0 0 0 1px rgba(94,234,212,.08);
      transform-origin: bottom right;
      animation: zion-card-in 0.38s cubic-bezier(.22,1,.36,1) both;
      overflow-x: hidden;
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      max-height: min(88dvh, 720px);
    }
    .zion-offer-card.is-leaving {
      animation: zion-card-out 0.28s ease-in forwards;
      pointer-events: none;
    }
    .zion-offer-card::before {
      content: '';
      position: absolute;
      inset: 0 0 auto 0;
      height: 2px;
      background: linear-gradient(90deg, #5eead4, #f8fafc, #5eead4);
      opacity: 0.85;
    }
    .zion-offer-kicker {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: #5eead4;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .zion-offer-title {
      color: #f8fafc;
      font-size: 1.05rem;
      font-weight: 700;
      margin-top: 0.15rem;
      line-height: 1.25;
      word-break: break-word;
    }
    .zion-offer-body {
      margin: 0.55rem 0 0.65rem;
      color: #cbd5e1;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .zion-offer-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.35rem;
      margin-bottom: 0.5rem;
    }
    .zion-offer-stat {
      background: #02061799;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 0.3rem 0.4rem;
      min-width: 0;
    }
    .zion-offer-stat .lbl {
      display: block;
      font-size: 0.6rem;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .zion-offer-stat .val {
      color: #e2e8f0;
      font-weight: 650;
      font-size: 0.78rem;
      overflow-wrap: anywhere;
    }
    .zion-offer-stat .sub {
      display: block;
      margin-top: 0.12rem;
      font-size: 0.65rem;
      font-weight: 500;
      color: #94a3b8;
    }
    .zion-offer-stat .sub strong {
      color: #cbd5e1;
      font-weight: 600;
    }
    .zion-countdown {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
      margin: 0.35rem 0 0.55rem;
      font-size: 0.72rem;
      color: #94a3b8;
    }
    .zion-countdown-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .zion-countdown-bar {
      flex: 1;
      height: 4px;
      border-radius: 999px;
      background: #1e293b;
      overflow: hidden;
      min-width: 0;
    }
    .zion-countdown-bar > span {
      display: block;
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, #5eead4, #34d399);
      transform-origin: left center;
      transition: transform 0.2s linear;
    }
    .zion-offer-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
    }
    .zion-offer-actions .btn {
      min-height: 2.35rem;
    }
    .zion-offer-actions .btn.is-expired,
    .zion-offer-actions .btn:disabled {
      opacity: 0.42;
      pointer-events: none;
      filter: grayscale(0.35);
      cursor: not-allowed;
    }
    .zion-cand-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: center;
      margin-top: 0.45rem;
    }
    .zion-cand-card .mint-ca,
    .zion-offer-row .mint-ca {
      margin-top: 0.3rem;
    }
    .zion-offer-card .mint-ca {
      flex-wrap: wrap;
    }
    .zion-offer-card .grid.grid-cols-2 {
      gap: 0.45rem;
    }
    @media (max-width: 640px) {
      .zion-offer-stack {
        right: max(8px, env(safe-area-inset-right, 0px));
        left: max(8px, env(safe-area-inset-left, 0px));
        bottom: max(8px, env(safe-area-inset-bottom, 0px));
        width: auto;
        max-width: none;
      }
      .zion-offer-card {
        padding: 11px 12px 10px;
        border-radius: 12px;
      }
      .zion-offer-title {
        font-size: 1rem;
      }
      .zion-offer-stats {
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 0.3rem;
      }
      .zion-offer-stat .val {
        font-size: 0.72rem;
      }
      .zion-offer-stack[data-count="1"] .zion-offer-card {
        max-height: min(84dvh, 680px);
      }
      .zion-offer-stack[data-count="2"] .zion-offer-card {
        max-height: min(42dvh, 380px);
      }
      .zion-offer-stack[data-count="3"] .zion-offer-card,
      .zion-offer-stack[data-count="4"] .zion-offer-card,
      .zion-offer-stack[data-count="5"] .zion-offer-card {
        max-height: min(30dvh, 300px);
      }
    }
    @keyframes zion-card-in {
      from { opacity: 0; transform: translateY(18px) scale(0.96); }
      to { opacity: 1; transform: none; }
    }
    @keyframes zion-card-out {
      to { opacity: 0; transform: translateY(12px) scale(0.96); }
    }
    @media (prefers-reduced-motion: reduce) {
      .zion-offer-card,
      .zion-offer-card.is-leaving,
      .zion-cand-card {
        animation: none !important;
        transition: none !important;
      }
    }
    .wallet-copy-cell {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.2rem;
      min-width: 0;
    }
    .wallet-copy-row {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.35rem;
      max-width: 100%;
    }
    .wallet-copy-cell .ca-btn {
      padding: 0.05rem 0.35rem;
      font-size: 0.65rem;
      line-height: 1.2;
      border-radius: 0.3rem;
    }
    .pos-token-main .trade-profile-badge,
    .trade-group-summary .trade-profile-badge {
      display: none; /* profile lives in PROFILE column only */
    }
    .tp-chip,
    .tp-overview-name,
    .tp-name {
      font-weight: 600;
    }
    #positions-table th:nth-child(2),
    #trades-positions-table th:nth-child(2),
    #closed-table th:nth-child(2),
    #trades-closed-table th:nth-child(2),
    #positions-table td:nth-child(2),
    #trades-positions-table td:nth-child(2),
    #closed-table td:nth-child(2),
    #trades-closed-table td:nth-child(2) {
      min-width: 7.5rem;
      white-space: nowrap;
    }
    .profile-colour-legend {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
      padding: 0.55rem 0.7rem;
      border: 1px solid #1e293b;
      border-radius: 0.5rem;
      background: linear-gradient(180deg, #0f172a 0%, #0b1220 100%);
    }
    .profile-colour-legend-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .profile-colour-legend-title {
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #cbd5e1;
    }
    .profile-colour-legend-hint {
      font-size: 0.65rem;
      color: #64748b;
    }
    .profile-colour-legend-items {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 0.45rem;
    }
    .profile-colour-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.45rem 0.2rem 0.3rem;
      border-radius: 999px;
      border: 1px solid;
      background: #020617aa;
      font-size: 0.68rem;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      max-width: 100%;
    }
    .profile-colour-legend-swatch {
      width: 0.7rem;
      height: 0.7rem;
      border-radius: 0.2rem;
      flex-shrink: 0;
      box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.65);
    }
    .profile-colour-legend-icon {
      font-size: 0.75rem;
      line-height: 1;
      flex-shrink: 0;
    }
    .profile-colour-legend-name {
      color: #e2e8f0;
    }
    @media (max-width: 640px) {
      .profile-colour-legend {
        padding: 0.5rem 0.55rem;
      }
      .profile-colour-legend-items {
        gap: 0.3rem;
      }
      .profile-colour-legend-item {
        font-size: 0.64rem;
        padding: 0.18rem 0.4rem 0.18rem 0.28rem;
        gap: 0.28rem;
      }
      .profile-colour-legend-swatch {
        width: 0.62rem;
        height: 0.62rem;
      }
      .profile-colour-legend-hint {
        display: none;
      }
    }
    /* Profile filter chips — colour from --profile-color; white text when active */
    .closed-filter-btn[data-closed-profile-filter]:not([data-closed-profile-filter="all"]),
    .closed-filter-btn[data-open-profile-filter]:not([data-open-profile-filter="all"]) {
      color: var(--profile-color, #cbd5e1) !important;
      border-color: var(--profile-color, #64748b) !important;
      background: #1e293b !important;
      background: color-mix(in srgb, var(--profile-color, #64748b) 16%, #1e293b) !important;
    }
    .closed-filter-btn[data-closed-profile-filter]:not([data-closed-profile-filter="all"]):hover,
    .closed-filter-btn[data-closed-profile-filter]:not([data-closed-profile-filter="all"]):focus-visible,
    .closed-filter-btn[data-open-profile-filter]:not([data-open-profile-filter="all"]):hover,
    .closed-filter-btn[data-open-profile-filter]:not([data-open-profile-filter="all"]):focus-visible {
      color: #f8fafc !important;
      background: color-mix(in srgb, var(--profile-color, #64748b) 30%, #1e293b) !important;
      border-color: var(--profile-color, #94a3b8) !important;
    }
    .closed-filter-btn[data-closed-profile-filter].is-active:not([data-closed-profile-filter="all"]),
    .closed-filter-btn[data-open-profile-filter].is-active:not([data-open-profile-filter="all"]) {
      color: #ffffff !important;
      font-weight: 700;
      background: var(--profile-color, #10b981) !important;
      border-color: var(--profile-color, #34d399) !important;
      box-shadow: none;
    }
    .closed-filter-btn[data-closed-profile-filter="all"].is-active,
    .closed-filter-btn[data-open-profile-filter="all"].is-active {
      color: #ecfdf5 !important;
      background: rgba(16, 185, 129, 0.28) !important;
      border-color: rgba(52, 211, 153, 0.65) !important;
      box-shadow: none;
    }
    .trade-profiles-active {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      align-items: center;
    }
    .trade-profiles-active .tp-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-size: 0.7rem;
      padding: 0.15rem 0.45rem;
      border-radius: 999px;
      border: 1px solid;
      opacity: 0.95;
    }
    .trade-profiles-active .tp-chip.is-off {
      /* Avoid opacity — it greys the modules popover too */
      filter: grayscale(0.55);
      opacity: 1;
      color: #94a3b8 !important;
      border-color: #475569 !important;
      background: #1e293b !important;
    }
    .tp-toggle-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: stretch;
      overflow: visible;
    }
    .tp-toggle-card {
      flex: 1 1 16rem;
      min-width: 14rem;
      max-width: 22rem;
      padding: 0.55rem 0.65rem;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      background: #0f172a;
      overflow: visible;
    }
    .tp-toggle-card .tp-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.4rem;
      margin-bottom: 0.25rem;
      overflow: visible;
    }
    .tp-toggle-card .tp-head input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      min-width: 1rem;
      flex-shrink: 0;
      accent-color: #10b981;
    }
    .tp-toggle-card .tp-name { font-weight: 600; font-size: 0.8rem; }
    /* Profile module allowlist popover (chip / card name hover) */
    .tp-mod-tip {
      position: relative;
      cursor: help;
      -webkit-tap-highlight-color: transparent;
    }
    .tp-mod-tip:focus,
    .tp-mod-tip:focus-visible {
      outline: none;
      z-index: 230;
    }
    .tp-mod-pop {
      position: absolute;
      left: 0;
      top: calc(100% + 8px);
      z-index: 220;
      box-sizing: border-box;
      width: max-content;
      min-width: 11.5rem;
      max-width: min(16.5rem, calc(100vw - 1.5rem));
      max-height: min(18rem, 55vh);
      overflow: auto;
      padding: 0.55rem 0.65rem;
      border-radius: 0.5rem;
      background: #0b1220;
      border: 1px solid #334155;
      box-shadow: 0 12px 28px rgba(2, 6, 23, 0.55);
      color: #cbd5e1;
      font-size: 11px;
      font-weight: 500;
      line-height: 1.35;
      text-align: left;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity 0.12s ease;
    }
    .tp-mod-tip:hover .tp-mod-pop,
    .tp-mod-tip:focus .tp-mod-pop,
    .tp-mod-tip:focus-within .tp-mod-pop,
    .tp-mod-tip:focus-visible .tp-mod-pop {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    .tp-mod-pop .tp-mod-title {
      font-weight: 650;
      color: #e2e8f0;
      font-size: 11px;
      margin-bottom: 0.3rem;
    }
    .tp-mod-pop .tp-mod-note {
      color: #94a3b8;
      font-size: 10px;
      margin-bottom: 0.35rem;
      line-height: 1.3;
    }
    .tp-mod-pop .tp-mod-inherit,
    .tp-mod-pop .tp-mod-empty {
      color: #94a3b8;
      font-size: 11px;
    }
    .tp-mod-pop .tp-mod-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.22rem;
    }
    .tp-mod-pop .tp-mod-list li {
      display: flex;
      align-items: baseline;
      gap: 0.35rem;
      color: #e2e8f0;
    }
    .tp-mod-pop .tp-mod-list li.is-off {
      color: #64748b;
    }
    .tp-mod-pop .tp-mod-dot {
      width: 0.4rem;
      height: 0.4rem;
      border-radius: 999px;
      flex: 0 0 auto;
      margin-top: 0.28rem;
      background: #34d399;
    }
    .tp-mod-pop .tp-mod-list li.is-off .tp-mod-dot {
      background: #475569;
    }
    .tp-mod-pop .tp-mod-name {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: break-word;
    }
    .tp-mod-pop .tp-mod-off {
      flex: 0 0 auto;
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #64748b;
      font-weight: 700;
    }
    .trade-profiles-active {
      overflow: visible;
    }
    .trade-profiles-active .tp-chip.tp-mod-tip {
      position: relative;
    }
    .tp-toggle-card .tp-blurb {
      margin: 0.35rem 0 0.25rem;
      font-size: 0.72rem;
      color: #cbd5e1;
      line-height: 1.35;
    }
    .tp-toggle-card .tp-risk {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      margin: 0.15rem 0 0.35rem;
      font-size: 0.65rem;
      color: #94a3b8;
      line-height: 1.3;
      flex-wrap: wrap;
    }
    .tp-toggle-card .tp-risk-label {
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
      font-size: 0.58rem;
    }
    .tp-toggle-card .tp-risk-value {
      color: #e2e8f0;
      font-weight: 600;
      padding: 0.1rem 0.4rem;
      border-radius: 0.3rem;
      background: #1e293b;
      border: 1px solid #334155;
    }
    .tp-toggle-card .tp-desc { font-size: 0.65rem; color: #94a3b8; line-height: 1.3; }
    .tp-toggle-card details.tp-rules {
      margin-top: 0.2rem;
    }
    .tp-toggle-card details.tp-rules > summary {
      cursor: pointer;
      font-size: 0.62rem;
      color: #64748b;
      list-style: none;
      user-select: none;
    }
    .tp-toggle-card details.tp-rules > summary::-webkit-details-marker { display: none; }
    .tp-toggle-card details.tp-rules[open] > summary { color: #94a3b8; margin-bottom: 0.2rem; }
    @media (max-width: 640px) {
      .tp-toggle-card {
        flex: 1 1 100%;
        min-width: 0;
        max-width: none;
      }
    }
    .tp-toggle-card.tp-card-flash {
      outline: 2px solid #38bdf8;
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.15);
    }
    .tp-decisions {
      max-height: 11rem;
      overflow-y: auto;
      border: 1px solid #1e293b;
      border-radius: 0.45rem;
      background: #020617;
      padding: 0.4rem 0.5rem;
      font-size: 0.7rem;
      line-height: 1.35;
    }
    .tp-decision-row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 0.35rem 0.55rem;
      padding: 0.3rem 0;
      border-bottom: 1px solid #1e293b;
      align-items: start;
    }
    .tp-decision-row:last-child { border-bottom: none; }
    .tp-decision-row.is-skip { opacity: 0.75; }
    .tp-decision-score {
      font-weight: 700;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    .tp-decision-meta { color: #94a3b8; }
    .tp-decision-why { color: #cbd5e1; grid-column: 1 / -1; }
    .tp-params {
      margin-top: 0.45rem;
      padding-top: 0.4rem;
      border-top: 1px solid #1e293b;
      display: grid;
      gap: 0.5rem;
    }
    .tp-param-section {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.3rem 0.45rem;
      min-width: 0;
    }
    .tp-param-title {
      grid-column: 1 / -1;
      margin: 0;
      font-size: 0.68rem;
      font-weight: 700;
      color: #cbd5e1;
    }
    .tp-param-hint {
      grid-column: 1 / -1;
      margin: -0.1rem 0 0;
      color: #94a3b8;
      font-size: 0.62rem;
    }
    .tp-params label {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      font-size: 0.62rem;
      color: #94a3b8;
      min-width: 0;
    }
    .tp-params label > input:not([type="checkbox"]),
    .tp-params label > select {
      width: 100%;
      background: #020617;
      border: 1px solid #334155;
      border-radius: 0.3rem;
      color: #e2e8f0;
      font-size: 0.72rem;
      padding: 0.2rem 0.35rem;
    }
    .tp-qf {
      grid-column: 1 / -1;
      margin-top: 0.35rem;
      padding-top: 0.45rem;
      border-top: 1px solid #334155;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.35rem 0.5rem;
      min-width: 0;
    }
    .tp-qf > p {
      grid-column: 1 / -1;
    }
    .tp-qf > label {
      display: flex;
      flex-direction: column;
      gap: 0.1rem;
      font-size: 0.62rem;
      color: #94a3b8;
      min-width: 0;
    }
    .tp-qf > label > input:not([type="checkbox"]),
    .tp-qf > label > select {
      width: 100%;
      background: #020617;
      border: 1px solid #334155;
      border-radius: 0.3rem;
      color: #e2e8f0;
      font-size: 0.72rem;
      padding: 0.2rem 0.35rem;
    }
    .tp-qf > label.tp-check,
    .tp-params label.tp-check {
      grid-column: 1 / -1;
      flex-direction: row;
      align-items: center;
      gap: 0.45rem;
      font-size: 0.7rem;
      color: #cbd5e1;
      line-height: 1.3;
      white-space: normal;
    }
    .tp-qf > label.tp-check > input[type="checkbox"],
    .tp-params label.tp-check > input[type="checkbox"] {
      width: 1rem;
      height: 1rem;
      min-width: 1rem;
      flex-shrink: 0;
      margin: 0;
      accent-color: #10b981;
      background: transparent;
      border: none;
      padding: 0;
    }
    .tp-qf > label.tp-check > span,
    .tp-params label.tp-check > span {
      flex: 1 1 auto;
      min-width: 0;
      white-space: normal;
    }
    .tp-params-actions {
      grid-column: 1 / -1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.25rem;
    }
    .tp-params-actions button {
      font-size: 0.65rem;
      padding: 0.2rem 0.45rem;
    }
    .tp-override-badge {
      font-size: 0.58rem;
      color: #fbbf24;
      margin-left: 0.25rem;
    }
    .tp-overview-wrap {
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      border: 1px solid #1e293b;
      border-radius: 0.5rem;
    }
    .tp-overview-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.78rem;
      min-width: 36rem;
    }
    .tp-overview-table th,
    .tp-overview-table td {
      padding: 0.55rem 0.65rem;
      text-align: left;
      vertical-align: top;
      border-bottom: 1px solid #1e293b;
    }
    .tp-overview-table th {
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #94a3b8;
      background: #0b1220;
      position: sticky;
      top: 0;
      white-space: nowrap;
    }
    .tp-overview-table tbody tr {
      cursor: pointer;
      transition: background 0.12s ease;
    }
    .tp-overview-table tbody tr:hover {
      background: #111827;
    }
    .tp-overview-table tbody tr.is-active {
      background: #0f1f17;
    }
    .tp-overview-table tbody tr.is-active td:first-child {
      box-shadow: inset 3px 0 0 #34d399;
    }
    .tp-overview-table tbody tr.is-off {
      opacity: 0.55;
    }
    .tp-overview-name {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      font-weight: 600;
      color: #e2e8f0;
      white-space: nowrap;
    }
    .tp-overview-desc {
      color: #cbd5e1;
      line-height: 1.35;
      max-width: 22rem;
    }
    .tp-overview-style {
      color: #94a3b8;
      white-space: nowrap;
    }
    .tp-overview-risk {
      display: inline-block;
      font-weight: 600;
      color: #e2e8f0;
      padding: 0.12rem 0.45rem;
      border-radius: 0.3rem;
      background: #1e293b;
      border: 1px solid #334155;
      white-space: nowrap;
    }
    .tp-overview-active-tag {
      font-size: 0.58rem;
      font-weight: 600;
      color: #34d399;
      margin-left: 0.25rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    @media (max-width: 640px) {
      .tp-overview-table {
        min-width: 28rem;
        font-size: 0.72rem;
      }
      .tp-overview-table th,
      .tp-overview-table td {
        padding: 0.45rem 0.5rem;
      }
      .tp-overview-desc {
        max-width: 14rem;
      }
    }
    @media (max-width: 640px) {
      .closed-filter {
        width: 100%;
      }
      .closed-filter-btn {
        flex: 1 1 auto;
        justify-content: center;
        text-align: center;
        min-height: 2.35rem;
      }
    }
    .pos-size-card {
      min-width: 9.5rem;
      max-width: 15rem;
    }
    .pos-size-label {
      font-size: 10px;
      color: #64748b;
      margin-bottom: 0.1rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .pos-size-main {
      font-size: 12.5px;
      font-weight: 700;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
    }
    .pos-partial-line {
      margin-top: 0.3rem;
      font-size: 11px;
      line-height: 1.35;
      color: #cbd5e1;
      font-weight: 600;
      white-space: normal;
    }
    .pos-partial-line .pos-taken {
      color: #67e8f9;
      font-weight: 700;
    }
    .pos-partial-line .pos-remain {
      color: #e2e8f0;
      font-weight: 700;
    }
    .pos-remain-usd {
      margin-top: 0.2rem;
      font-size: 10px;
      color: #94a3b8;
      font-weight: 600;
    }
    .pos-partial-bar {
      margin-top: 0.4rem;
      height: 5px;
      border-radius: 999px;
      background: rgba(51, 65, 85, 0.9);
      overflow: hidden;
      max-width: 12rem;
    }
    .pos-partial-bar > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #34d399, #22d3ee);
    }
    .pos-pnl-cell {
      min-width: 5.5rem;
    }
    .pos-pnl-main {
      font-size: 13px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .pos-pnl-sub {
      margin-top: 0.2rem;
      font-size: 10px;
      color: #94a3b8;
      line-height: 1.35;
    }
    @media (max-width: 640px) {
      .pos-size-card { max-width: 12rem; }
      .pos-status-badge { font-size: 8.5px; padding: 0.2rem 0.4rem; }
    }
    .tp-check-list label {
      display: flex;
      align-items: flex-start;
      gap: 0.45rem;
      margin: 0.28rem 0;
      color: #cbd5e1;
      font-size: 0.72rem;
      line-height: 1.35;
      cursor: pointer;
    }
    .tp-check-list input[type="checkbox"] {
      margin-top: 0.15rem;
      flex-shrink: 0;
      accent-color: #34d399;
    }
    .tp-check-list label.is-done {
      color: #94a3b8;
      text-decoration: line-through;
      opacity: 0.85;
    }
    .tp-tuning-details > summary {
      list-style: none;
      cursor: pointer;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      user-select: none;
    }
    .tp-tuning-details > summary::-webkit-details-marker { display: none; }
    .tp-tuning-summary-main {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      min-width: 0;
    }
    .tp-tuning-chevron {
      display: inline-block;
      font-size: 0.65rem;
      color: #94a3b8;
      transition: transform 0.15s ease;
    }
    .tp-tuning-details[open] .tp-tuning-chevron {
      transform: rotate(90deg);
      color: #34d399;
    }
    .tp-tuning-details[open] .tp-tuning-summary-main .mint {
      display: none;
    }
    .trade-group-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.28rem;
      min-width: 2.5rem;
      min-height: 2rem;
      margin-right: 0.4rem;
      padding: 0.28rem 0.5rem;
      border-radius: 0.4rem;
      border: 1px solid rgba(148, 163, 184, 0.55) !important;
      background: #0f172a !important;
      color: #f1f5f9 !important;
      font-size: 10px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      vertical-align: top;
      flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
      box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.8);
    }
    .trade-group-toggle:hover,
    .trade-group-toggle:focus-visible {
      border-color: rgba(125, 211, 252, 0.75) !important;
      color: #ffffff !important;
      background: #1e293b !important;
      outline: none;
    }
    .trade-group-toggle[aria-expanded="true"] {
      border-color: rgba(52, 211, 153, 0.65) !important;
      background: #064e3b !important;
      color: #ecfdf5 !important;
    }
    .trade-group-chevron {
      display: inline-block;
      width: 0.7rem;
      font-size: 9px;
      color: inherit;
      transition: transform 0.15s ease;
    }
    .trade-group-toggle[aria-expanded="true"] .trade-group-chevron {
      transform: rotate(90deg);
    }
    .trade-group-expand-hint {
      font-size: 9px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: inherit !important;
      font-weight: 800;
      opacity: 0.95;
    }
    .trade-group-toggle[aria-expanded="true"] .trade-group-expand-hint {
      color: inherit !important;
    }
    .trade-group-head {
      display: flex;
      align-items: flex-start;
      gap: 0.35rem;
    }
    .trade-pnl-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      min-width: 1.35rem;
      height: 1.15rem;
      padding: 0 0.3rem;
      margin-right: 0.2rem;
      border-radius: 999px;
      font-size: 9px;
      font-weight: 800;
      letter-spacing: 0.02em;
      line-height: 1;
      vertical-align: middle;
      border: 1px solid transparent;
    }
    .trade-pnl-badge.is-pos {
      color: #052e1c;
      background: #34d399;
      border-color: #6ee7b7;
    }
    .trade-pnl-badge.is-neg {
      color: #450a0a;
      background: #f87171;
      border-color: #fca5a5;
    }
    .trade-pnl-badge.is-flat {
      color: #0f172a;
      background: #94a3b8;
      border-color: #cbd5e1;
    }
    tr.trade-group-parent td {
      background: rgba(15, 23, 42, 0.55);
      vertical-align: top;
      border-top: 2px solid rgba(71, 85, 105, 0.75);
      padding-top: 0.85rem;
      padding-bottom: 0.8rem;
    }
    tr.trade-group-parent:first-child td {
      border-top-color: rgba(52, 211, 153, 0.28);
    }
    tr.trade-group-parent.is-expanded td {
      background: rgba(15, 23, 42, 0.72);
    }
    tr.trade-group-parent.is-expanded td:first-child {
      box-shadow: inset 3px 0 0 rgba(52, 211, 153, 0.45);
    }
    .trade-group-parent td:first-child {
      min-width: 12rem;
      max-width: 24rem;
    }
    tr.trade-group-child td {
      background: rgba(15, 23, 42, 0.28);
      font-size: 12px;
      color: #cbd5e1;
      border-left: none;
      padding-top: 0.55rem;
      padding-bottom: 0.55rem;
    }
    tr.trade-group-child td:first-child {
      padding-left: 1.85rem;
      box-shadow: inset 3px 0 0 rgba(71, 85, 105, 0.65);
    }
    tr.trade-group-child.trade-group-child-last td {
      border-bottom: 2px solid rgba(71, 85, 105, 0.55);
      padding-bottom: 0.85rem;
    }
    .trade-exit-label {
      display: inline-block;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.01em;
      color: #7dd3fc;
      margin-bottom: 0.15rem;
    }
    .trade-exit-label.is-final {
      color: #86efac;
    }
    .trade-group-summary {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: 0.2rem 0.35rem;
      font-size: 12.5px;
      line-height: 1.35;
      color: #e2e8f0;
      font-weight: 700;
      max-width: 22rem;
    }
    .trade-group-summary-token {
      color: #f8fafc;
      font-weight: 800;
    }
    .trade-group-summary-sep {
      color: #64748b;
      font-weight: 600;
    }
    .trade-group-summary-exits {
      color: #cbd5e1;
      font-weight: 700;
    }
    .trade-group-summary-entry {
      color: #e2e8f0;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .trade-group-summary-pnl {
      font-weight: 800;
      font-variant-numeric: tabular-nums;
    }
    .trade-group-summary-pnl.is-pos {
      color: var(--green) !important;
    }
    .trade-group-summary-pnl.is-neg {
      color: var(--red) !important;
    }
    .trade-group-summary-pnl.is-flat {
      color: var(--muted) !important;
    }
    .trade-group-summary-exit {
      color: #7dd3fc;
      font-weight: 700;
      white-space: nowrap;
    }
    .trade-group-summary-sub {
      margin-top: 0.35rem;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      line-height: 1.35;
      white-space: normal;
    }
    .trade-group-summary-hold {
      color: #cbd5e1;
      font-variant-numeric: tabular-nums;
    }
    .trade-group-meta {
      font-size: 10px;
      color: #64748b;
      margin-top: 0.15rem;
    }
    @media (max-width: 640px) {
      .trade-group-summary {
        font-size: 12px;
        max-width: 16rem;
      }
      .trade-group-parent td:first-child {
        max-width: 16rem;
      }
      .trade-group-toggle {
        min-width: 2.75rem;
        min-height: 2.25rem;
      }
      .trade-group-expand-hint {
        display: none;
      }
    }
    .stat { font-size: 1.5rem; font-weight: 700; color: #34d399; }
    .ov-equity-panel {
      display: grid;
      gap: 0.65rem 0.85rem;
      padding: 0.85rem 1rem;
      border-radius: 12px;
      border: 1px solid rgba(52, 211, 153, 0.28);
      background:
        linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(15, 23, 42, 0.92) 42%, rgba(15, 23, 42, 0.98));
    }
    .ov-equity-main {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.25rem 1rem;
    }
    .ov-equity-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6ee7b7;
    }
    .ov-equity-value {
      font-size: clamp(1.55rem, 5.5vw, 2rem);
      font-weight: 800;
      color: #34d399;
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    .ov-equity-value .ov-unit {
      font-size: 0.55em;
      font-weight: 650;
      color: #94a3b8;
      margin-left: 0.3rem;
    }
    .ov-usd {
      font-size: 0.78em;
      font-weight: 500;
      color: #64748b !important;
      margin-left: 0.28rem;
      letter-spacing: 0;
    }
    .ov-equity-value .ov-usd {
      font-size: 0.38em;
      font-weight: 500;
      color: #64748b !important;
      margin-left: 0.35rem;
      vertical-align: baseline;
    }
    .ov-reset-wrap {
      display: flex;
      align-items: flex-end;
      gap: 0.65rem;
      flex-shrink: 0;
      margin-left: auto;
    }
    .ov-reset-meta {
      text-align: right;
      line-height: 1.25;
      min-width: 0;
    }
    .ov-reset-elapsed {
      font-size: 12px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: #94a3b8;
      letter-spacing: 0.02em;
    }
    .ov-reset-at {
      font-size: 10px;
      font-weight: 500;
      color: #64748b;
      white-space: nowrap;
    }
    .ov-equity-rows {
      display: grid;
      gap: 0.45rem;
    }
    .ov-equity-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.4rem 0.55rem;
    }
    .ov-equity-cell {
      min-width: 0;
      padding: 0.35rem 0.45rem;
      border-radius: 8px;
      background: rgba(2, 6, 23, 0.35);
      border: 1px solid rgba(51, 65, 85, 0.55);
    }
    .ov-equity-cell .lbl {
      display: block;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #64748b;
      margin-bottom: 0.12rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ov-equity-cell strong {
      display: block;
      font-size: clamp(0.82rem, 3.2vw, 0.98rem);
      font-weight: 700;
      color: #e2e8f0;
      font-variant-numeric: tabular-nums;
      white-space: normal;
      line-height: 1.25;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ov-meta-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.45rem;
    }
    @media (min-width: 640px) {
      .ov-meta-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }
    .ov-meta-strip .card {
      padding: 0.55rem 0.65rem;
      margin: 0;
    }
    .ov-meta-strip .stat,
    .ov-meta-strip .text-lg {
      font-size: clamp(0.95rem, 3.4vw, 1.15rem);
    }
    .toggle-row { display: flex; align-items: center; justify-content: space-between; padding: 0.55rem 0; border-bottom: 1px solid #1e293b; gap: 12px; }
    .toggle-row:last-child { border-bottom: none; }
    .section-title {
      font-size: 11px;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 0.75rem;
      display: inline-flex;
      align-items: center;
      gap: 0.15rem;
      flex-wrap: wrap;
    }
    .stat-label {
      font-size: 11px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: .04em;
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
    }

    /* Help tooltips — hover/focus/tap the ? icon (tabindex=0) */
    .tip {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 9999px;
      background: #334155;
      color: #cbd5e1;
      font-size: 10px;
      font-weight: 800;
      line-height: 1;
      cursor: help;
      flex-shrink: 0;
      position: relative;
      overflow: visible;
      border: 1px solid #475569;
      text-transform: none;
      letter-spacing: 0;
      vertical-align: middle;
      -webkit-tap-highlight-color: transparent;
    }
    .tip::before { content: '?'; }
    /*
      Tip bubble width must NOT use % of .tip (15px host) — that collapses
      max-width to ~10px and wraps one word per line. Use vw / px instead.
    */
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      left: 50%;
      bottom: calc(100% + 8px);
      transform: translateX(-50%);
      box-sizing: border-box;
      width: max-content;
      min-width: 12.5rem; /* 200px */
      max-width: min(17.5rem, calc(100vw - 1.5rem)); /* 280px */
      padding: 8px 10px;
      border-radius: 8px;
      background: #0f172a;
      border: 1px solid #38bdf8;
      color: #e2e8f0;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.35;
      text-transform: none;
      letter-spacing: 0;
      white-space: normal;
      overflow-wrap: break-word;
      word-wrap: break-word;
      text-align: left;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity .12s ease;
      z-index: 200;
    }
    .tip:hover,
    .tip:focus,
    .tip:focus-visible {
      z-index: 210;
      outline: none;
    }
    .tip:hover::after,
    .tip:focus::after,
    .tip:focus-visible::after {
      opacity: 1;
      visibility: visible;
    }
    /* Flip tip downward when near top of viewport (approx via tip-below) */
    .tip.tip-below::after {
      bottom: auto;
      top: calc(100% + 8px);
    }
    /* Tip hosts: do not clip absolute ::after bubbles */
    .card,
    .stat-label,
    .section-title,
    .section-title-open,
    .title-left,
    .ctl > span {
      overflow: visible;
    }
    .has-tip { cursor: help; }

    /* Token ticker → click to copy CA (native title tip; Mint col has Copy/Jupiter) */
    .token-ca {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      cursor: pointer;
      border-bottom: 1px dashed #475569;
    }
    .token-ca:hover { color: #7dd3fc; border-bottom-color: #38bdf8; }
    .token-ca.copied { color: #34d399; border-bottom-color: #34d399; }
    .ca-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem;
      margin-top: 0.5rem;
    }
    .ca-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.2rem 0.55rem;
      border-radius: 0.4rem;
      font-size: 11px;
      font-weight: 600;
      border: 1px solid #334155;
      background: #1e293b;
      color: #e2e8f0;
      cursor: pointer;
      text-decoration: none;
      line-height: 1.3;
    }
    .ca-btn:hover { border-color: #38bdf8; color: #7dd3fc; }
    .ca-btn.ca-jup {
      border-color: rgba(16, 185, 129, 0.45);
      background: rgba(16, 185, 129, 0.12);
      color: #6ee7b7;
    }
    .ca-btn.ca-jup:hover { border-color: #34d399; color: #a7f3d0; }
    .mint-ca {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      flex-wrap: wrap;
    }
    .mint-ca .ca-btn {
      padding: 0.12rem 0.4rem;
      font-size: 10px;
    }
    .wallet-addr {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .wallet-addr .ca-btn {
      padding: 0.1rem 0.35rem;
      font-size: 10px;
      flex-shrink: 0;
    }
    .wallet-addr .ca-btn.copied {
      border-color: #34d399;
      color: #6ee7b7;
    }
    .persist-banner {
      display: none;
      margin-top: 1.25rem;
      margin-bottom: 0;
      padding: 0.75rem 1rem;
      border-radius: 0.65rem;
      border: 1px solid #b45309;
      background: rgba(180, 83, 9, 0.15);
      color: #fbbf24;
      font-size: 13px;
      line-height: 1.45;
    }
    .persist-banner + .persist-banner {
      margin-top: 0.65rem;
    }
    .page-alerts {
      margin-top: 1.5rem;
      padding-top: 0.25rem;
    }
    .persist-banner strong { color: #fde68a; }

    /* ========== Responsive layout (mobile / tablet / desktop) ========== */
    html {
      -webkit-text-size-adjust: 100%;
      height: 100%;
      max-width: 100%;
      overflow-x: clip;
    }
    body {
      overflow-x: clip;
      max-width: 100%;
      min-height: 100%;
      min-height: 100dvh;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .page-shell {
      width: 100%;
      max-width: min(80rem, 100%);
      margin-left: auto;
      margin-right: auto;
      padding: 1rem 1rem 2.5rem;
      min-width: 0;
      overflow-x: clip;
      box-sizing: border-box;
    }
    [data-tab-panel] {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      overflow-x: clip;
      box-sizing: border-box;
    }
    [data-tab-panel].hidden {
      display: none !important;
    }
    .panel-scroll {
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior: contain;
      max-width: 100%;
      min-width: 0;
    }
    .panel-scroll.overflow-x-auto,
    .overflow-x-auto.panel-scroll {
      overflow-x: auto;
    }
    .log-entry {
      overflow-wrap: anywhere;
      word-break: break-word;
      max-width: 100%;
    }
    #activity .mint,
    #trades-activity .mint,
    #activity-signals .mint {
      white-space: normal;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .header-bar {
      display: grid;
      grid-template-columns: 1fr auto;
      grid-template-areas:
        "brand settings"
        "actions actions";
      align-items: start;
      gap: 0.45rem 0.5rem;
      margin-bottom: 0.65rem;
    }
    .header-brand { grid-area: brand; min-width: 0; }
    .header-brand h1 { font-size: clamp(1.05rem, 2.8vw, 1.65rem); line-height: 1.15; }
    .header-brand p { margin-top: 0.1rem !important; font-size: 0.7rem; line-height: 1.2; }
    .header-actions {
      grid-area: actions;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.3rem 0.4rem;
      min-width: 0;
      max-width: 100%;
      width: 100%;
      box-sizing: border-box;
      padding: 0.35rem 0.5rem !important;
    }
    .header-actions .status-meta {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.25rem 0.45rem;
      min-width: 0;
      flex: 1 1 12rem;
    }
    .header-actions .status-controls {
      display: inline-flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: flex-end;
      gap: 0.25rem;
      margin-left: auto;
      min-width: 0;
      max-width: 100%;
    }
    .header-actions .status-stat {
      font-size: 0.7rem;
      color: #94a3b8;
      white-space: nowrap;
      line-height: 1.2;
    }
    .header-actions .status-stat strong { color: #e2e8f0; font-weight: 650; }
    .header-actions #rpc-status-wrap {
      max-width: 9.5rem;
      overflow: hidden;
    }
    .header-actions #rpc-active {
      display: inline-block;
      max-width: 7.5rem;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      white-space: nowrap;
    }
    .header-actions #rpc-latency {
      display: inline-block;
      min-width: 3.75rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .header-actions #status-text { font-size: 0.75rem; line-height: 1.2; }
    .header-actions .badge { padding: 1px 7px; font-size: 10px; letter-spacing: 0.02em; }
    .header-actions .strict-badge,
    .header-actions .risk-badge { padding: 1px 7px; font-size: 10px; }
    .header-actions .strict-badge svg,
    .header-actions .risk-badge svg { width: 10px; height: 10px; }
    .header-actions .dot { width: 8px; height: 8px; flex: 0 0 auto; }
    .header-actions .status-ico { width: 11px; height: 11px; }
    .header-actions .run-status { padding: 1px 6px 1px 3px; }
    .header-actions .btn {
      flex: 0 0 auto;
      min-height: 1.85rem;
      padding: 0.2rem 0.5rem;
      font-size: 11px;
      border-radius: 0.4rem;
    }
    .settings-menu-wrap {
      grid-area: settings;
      position: relative;
      flex: 0 0 auto;
      z-index: 40;
    }
    .settings-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 2.35rem;
      height: 2.35rem;
      min-width: 40px;
      min-height: 40px;
      padding: 0;
      border-radius: 0.45rem;
      background: #1e293b;
      border: 1px solid #334155;
      color: #94a3b8;
      cursor: pointer;
      transition: background .15s, color .15s, border-color .15s;
    }
    .settings-btn:hover {
      background: #334155;
      color: #e2e8f0;
    }
    .settings-btn:focus-visible {
      outline: 2px solid #38bdf8;
      outline-offset: 2px;
    }
    .settings-btn.settings-active,
    .settings-btn[aria-expanded="true"] {
      background: #1e293b;
      border-color: #34d399;
      color: #6ee7b7;
      box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.25);
    }
    .settings-btn svg {
      width: 1.25rem;
      height: 1.25rem;
      display: block;
    }
    .settings-dropdown {
      display: none;
      position: absolute;
      right: 0;
      left: auto;
      top: calc(100% + 0.4rem);
      min-width: 10.5rem;
      width: max-content;
      max-width: min(16rem, calc(100% - 1.5rem));
      padding: 0.3rem;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 0.5rem;
      box-shadow: 0 10px 28px rgba(2, 6, 23, 0.55), 0 0 0 1px rgba(15, 23, 42, 0.4);
      z-index: 50;
    }
    .settings-dropdown.open { display: block; }
    .settings-dropdown button,
    .settings-dropdown button[data-settings-tab] {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      width: 100%;
      min-height: 2.5rem;
      padding: 0.45rem 0.7rem;
      margin: 0;
      border: none;
      border-left: 2px solid transparent;
      border-radius: 0.35rem;
      background: transparent !important;
      color: #94a3b8 !important;
      font-size: 0.8125rem;
      font-weight: 550;
      font-family: inherit;
      text-align: left;
      cursor: pointer;
      box-shadow: none !important;
      transition: background .12s, color .12s, border-color .12s;
    }
    .settings-dropdown button .settings-item-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 1.1rem;
      height: 1.1rem;
      flex-shrink: 0;
      color: #64748b;
    }
    .settings-dropdown button .settings-item-icon svg {
      width: 100%;
      height: 100%;
      display: block;
    }
    .settings-dropdown button:hover {
      background: #1e293b !important;
      color: #e2e8f0 !important;
      border-left-color: #475569;
    }
    .settings-dropdown button:hover .settings-item-icon { color: #94a3b8; }
    .settings-dropdown button.active {
      background: rgba(16, 185, 129, 0.12) !important;
      color: #a7f3d0 !important;
      border-left-color: #34d399;
      font-weight: 600;
    }
    .settings-dropdown button.active .settings-item-icon { color: #34d399; }
    .settings-dropdown button:focus-visible {
      outline: 2px solid #38bdf8;
      outline-offset: -2px;
    }
    @media (max-width: 639px) {
      .settings-dropdown button,
      .settings-dropdown button[data-settings-tab] {
        min-height: 2.75rem;
        padding: 0.55rem 0.75rem;
        font-size: 0.875rem;
      }
    }
    .nav-tabs {
      display: flex;
      flex-wrap: nowrap;
      gap: 0.4rem;
      margin-bottom: 1rem;
      position: sticky;
      top: 0;
      z-index: 30;
      background: rgba(11, 18, 32, 0.94);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      padding: 0.5rem 0.25rem;
      margin-left: -0.25rem;
      margin-right: -0.25rem;
      overflow-x: auto;
      overflow-y: hidden;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
      border-bottom: 1px solid transparent;
    }
    .nav-tabs::-webkit-scrollbar { display: none; height: 0; }
    .nav-tabs .btn {
      flex: 0 0 auto;
      white-space: nowrap;
      scroll-snap-align: start;
      min-height: 2.5rem;
    }
    /* Zion — apricot orange (#f2ae66) matching Cursor "Build Locally" accent */
    .nav-tabs .btn.nav-tab-zion {
      background: rgba(242, 174, 102, 0.18);
      color: #f2ae66;
      border: 1px solid rgba(242, 174, 102, 0.45);
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    .nav-tabs .btn.nav-tab-zion:hover {
      background: rgba(242, 174, 102, 0.32);
      color: #f8d2a8;
      border-color: rgba(242, 174, 102, 0.75);
    }
    .nav-tabs .btn.nav-tab-zion-active {
      background: #f2ae66;
      color: #1a1208;
      border-color: #f2ae66;
      box-shadow: 0 0 0 1px rgba(242, 174, 102, 0.35), 0 8px 18px rgba(242, 174, 102, 0.22);
    }
    .nav-tabs .btn.nav-tab-zion .btn-label-full::before,
    .nav-tabs .btn.nav-tab-zion .btn-label-short::before {
      content: '◈ ';
      opacity: 0.9;
    }
    @media (max-width: 640px) {
      .nav-tabs .btn.nav-tab-zion {
        padding-left: 0.7rem;
        padding-right: 0.7rem;
      }
    }
    .zion-panel .zion-hero-card {
      border: 1px solid rgba(242, 174, 102, 0.3);
      background: linear-gradient(160deg, rgba(80, 48, 18, 0.4) 0%, #0f172a 42%, #111827 100%);
      box-shadow: inset 0 1px 0 rgba(242, 174, 102, 0.14);
    }
    .zion-panel .zion-hero-card .section-title {
      color: #f2ae66;
    }
    .zion-panel .zion-accent {
      color: #f2ae66;
    }
    .overflow-x-auto {
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
      max-width: 100%;
      min-width: 0;
      width: 100%;
    }
    .overflow-x-auto table {
      min-width: 36rem;
    }
    #bt-results-table { min-width: 64rem; }
    #positions-table,
    #trades-positions-table { min-width: 56rem; }
    #closed-table,
    #trades-closed-table { min-width: 58rem; }
    #pump-activity-table,
    #sizing-signals-table,
    #rebuy-table { min-width: 32rem; }
    .pos-hold {
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      line-height: 1.25;
    }
    .pos-hold-dur { font-variant-numeric: tabular-nums; }
    .pos-hold-entry {
      display: none;
      margin-top: 0.15rem;
      font-size: 0.68rem;
      color: var(--muted);
      white-space: nowrap;
    }
    .pos-hold.show-entry .pos-hold-entry { display: block; }
    @media (hover: hover) and (pointer: fine) {
      .pos-hold { cursor: help; }
    }
    .pos-cost-cell { white-space: nowrap; font-size: 0.8rem; }
    .pos-vol-cell { white-space: nowrap; font-variant-numeric: tabular-nums; }
    #wallets-table, #search-wallets-table, #discover-wallets-table, #nansen-wallets-table { min-width: 48rem; }
    #discover-wallets-table th, #discover-wallets-table td,
    #nansen-wallets-table th, #nansen-wallets-table td,
    #wallets-table th, #wallets-table td,
    #search-wallets-table th, #search-wallets-table td {
      padding-left: 0.4rem;
      padding-right: 0.4rem;
      white-space: nowrap;
      font-size: 0.8rem;
    }
    #discover-wallets-table th, #wallets-table th, #search-wallets-table th, #nansen-wallets-table th {
      font-size: 0.72rem;
      letter-spacing: 0.01em;
    }
    .btn-label-full { display: none; }
    .btn-label-short { display: inline; }
    .stat { font-size: clamp(1.15rem, 4vw, 1.5rem); word-break: break-word; }
    .card { min-width: 0; }

    /* Sticky first column on wide tables (phones) */
    @media (max-width: 639px) {
      .overflow-x-auto table th:first-child,
      .overflow-x-auto table td:first-child {
        position: sticky;
        left: 0;
        z-index: 2;
        background: #1e293b;
        box-shadow: 4px 0 8px -4px rgba(0,0,0,.45);
      }
      .overflow-x-auto table thead th:first-child {
        z-index: 3;
        background: #1e293b;
      }
    }

    /* Phones */
    @media (max-width: 639px) {
      .page-shell { padding: 0.75rem 0.65rem 2rem; }
      .card { padding: 0.85rem; border-radius: 0.65rem; }
      .header-bar { margin-bottom: 0.5rem; gap: 0.35rem 0.4rem; }
      .header-actions {
        padding: 0.4rem 0.45rem !important;
        gap: 0.35rem;
      }
      .header-actions .status-meta {
        flex: 1 1 100%;
        gap: 0.2rem 0.4rem;
      }
      .header-actions .status-controls {
        flex: 1 1 100%;
        margin-left: 0;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.3rem;
      }
      .header-actions .btn {
        flex: unset;
        width: 100%;
        justify-content: center;
        min-height: 2.15rem;
        padding: 0.35rem 0.4rem;
        font-size: 11px;
      }
      .nav-tabs {
        scroll-snap-type: x proximity;
        gap: 0.35rem;
        padding-bottom: 0.65rem;
        border-bottom-color: #1e293b;
      }
      .nav-tabs .btn {
        min-height: 2.4rem;
        padding: 0.45rem 0.7rem;
        font-size: 12px;
      }
      .filters-row {
        gap: 0.5rem;
      }
      .filters-row > .ctl,
      .filters-row > label.ctl {
        flex: 1 1 calc(50% - 0.35rem);
        width: auto !important;
        min-width: calc(50% - 0.35rem);
      }
      .filters-row > .ctl-lg,
      .filters-row > label.ctl-lg {
        flex: 1 1 100%;
        min-width: 100%;
      }
      .filters-row .search-q {
        flex: 1 1 100%;
        min-width: 100%;
      }
      .filters-row > .btn,
      .filters-row > button {
        flex: 1 1 calc(50% - 0.35rem);
        justify-content: center;
        min-height: 2.5rem;
      }
      .filters-row > .ctl-check,
      .filters-row > label.ctl-check {
        flex: 1 1 100%;
        padding-top: 0.35rem;
        min-height: 2.25rem;
      }
      .ctl-sm, .ctl-md, .ctl-lg { width: 100%; }
      .ctl input:not([type="checkbox"]):not([type="radio"]),
      .ctl select { min-width: 0; }
      .toggle-row {
        gap: 0.75rem;
        padding: 0.65rem 0;
        font-size: 13px;
      }
      .chart-wrap { height: 180px; }
      /* Keep tip readable on narrow screens; % here was relative to 15px .tip */
      .tip::after {
        left: 50%;
        transform: translateX(-50%);
        width: min(15rem, calc(100vw - 1.5rem)); /* 240px */
        min-width: min(11.25rem, calc(100vw - 1.5rem)); /* 180px */
        max-width: min(17.5rem, calc(100vw - 1.5rem));
      }
      th, td { padding: 7px 5px; font-size: 12px; }
      .persist-banner { font-size: 12px; padding: 0.65rem 0.75rem; }
      #bt-debug-log { max-height: 12rem; }
    }

    /* Large phones / small tablets */
    @media (min-width: 480px) and (max-width: 767px) {
      .header-actions .btn { flex: 0 1 auto; }
      .filters-row > .ctl,
      .filters-row > label.ctl {
        flex: 1 1 calc(33.333% - 0.45rem);
        min-width: 6.5rem;
      }
    }

    /* Tablets */
    @media (min-width: 640px) and (max-width: 1023px) {
      .page-shell { padding: 1.1rem 1.5rem 2.25rem; }
      .btn-label-short { display: none; }
      .btn-label-full { display: inline; }
      .nav-tabs { flex-wrap: wrap; overflow-x: visible; scrollbar-width: thin; }
      .nav-tabs::-webkit-scrollbar { display: block; height: 4px; }
      .filters-row > .ctl,
      .filters-row > label.ctl {
        flex: 0 1 auto;
      }
      .ctl-sm { width: 5.25rem; }
      .ctl-md { width: 6.25rem; }
      .ctl-lg { width: 8.5rem; }
      .chart-wrap { height: 200px; }
      .overflow-x-auto table { min-width: 32rem; }
    }

    /* Desktop+ */
    @media (min-width: 1024px) {
      .page-shell {
        max-width: 90rem;
        padding: 1.5rem 2rem 3rem;
      }
      .btn-label-short { display: none; }
      .btn-label-full { display: inline; }
      .nav-tabs {
        flex-wrap: wrap;
        overflow-x: visible;
        gap: 0.5rem;
        padding: 0.65rem 0.15rem;
        scrollbar-width: thin;
      }
      .nav-tabs::-webkit-scrollbar { display: block; height: 4px; }
      .nav-tabs .btn { min-height: 2.25rem; padding: 0.5rem 0.9rem; }
      .header-bar {
        grid-template-columns: minmax(0, auto) minmax(0, 1fr) auto;
        grid-template-areas: "brand actions settings";
        align-items: center;
        gap: 0.5rem 0.75rem;
        margin-bottom: 0.75rem;
      }
      .header-actions {
        max-width: 100%;
        width: auto;
        justify-self: stretch;
        justify-content: flex-end;
        align-items: center;
        flex-wrap: nowrap;
        gap: 0.4rem 0.55rem;
        padding: 0.3rem 0.55rem !important;
        overflow: hidden;
        min-width: 0;
      }
      .header-actions .status-meta {
        flex: 1 1 auto;
        flex-wrap: nowrap;
        justify-content: flex-end;
        align-items: center;
        gap: 0.28rem 0.4rem;
        min-width: 0;
        overflow: hidden;
      }
      .header-actions .status-controls {
        flex: 0 0 auto;
        flex-wrap: nowrap;
        align-items: center;
        margin-left: 0.15rem;
        gap: 0.3rem;
      }
      .header-actions .btn {
        flex: 0 0 auto;
        white-space: nowrap;
        min-height: 1.75rem;
        padding: 0.18rem 0.45rem;
        font-size: 11px;
      }
      .header-actions .status-stat {
        font-size: 0.68rem;
      }
      /* Compact button labels until wide desktop so the bar stays one row */
      .header-actions .btn-label-short { display: inline; }
      .header-actions .btn-label-full { display: none; }
      .card { padding: 1.15rem; }
      .filters-row { gap: 0.65rem 0.75rem; }
      .chart-wrap { height: 240px; }
      .section-title { margin-bottom: 0.85rem; }
    }

    /* Wide desktop */
    @media (min-width: 1400px) {
      .page-shell {
        max-width: 96rem;
        padding: 1.75rem 2.5rem 3rem;
      }
      .header-actions .btn-label-short { display: none; }
      .header-actions .btn-label-full { display: inline; }
    }

    /* Prefer reduced motion */
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; scroll-behavior: auto !important; }
    }

    /* Safe area (notched phones) — additive, must not wipe media-query side padding */
    @supports (padding: max(0px)) {
      @media (max-width: 639px) {
        .page-shell {
          padding-left: max(0.65rem, env(safe-area-inset-left, 0px));
          padding-right: max(0.65rem, env(safe-area-inset-right, 0px));
          padding-bottom: max(2rem, env(safe-area-inset-bottom, 0px));
        }
      }
      @media (min-width: 640px) and (max-width: 1023px) {
        .page-shell {
          padding-left: max(1.5rem, env(safe-area-inset-left, 0px));
          padding-right: max(1.5rem, env(safe-area-inset-right, 0px));
        }
      }
      @media (min-width: 1024px) {
        .page-shell {
          padding-left: max(2rem, env(safe-area-inset-left, 0px));
          padding-right: max(2rem, env(safe-area-inset-right, 0px));
        }
      }
      @media (min-width: 1400px) {
        .page-shell {
          padding-left: max(2.5rem, env(safe-area-inset-left, 0px));
          padding-right: max(2.5rem, env(safe-area-inset-right, 0px));
        }
      }
      .nav-tabs { top: env(safe-area-inset-top, 0px); }
    }

    /* Override inline chart heights on small screens */
    @media (max-width: 639px) {
      .chart-wrap { height: 170px !important; }
      #logs-full, #system-logs { max-height: 60vh !important; }
      #activity, #trades-activity, #activity-signals { max-height: 16rem !important; }
      #migrations, #trades-migrations { max-height: 10rem !important; }
      .positions-scroll,
      .closed-trades-scroll { max-height: min(70vh, 28rem); }
      .btn { min-height: 2.5rem; }
      .risk-level-toggle .btn,
      #risk-level-toggle .btn { min-height: 2.5rem; flex: 1 1 auto; justify-content: center; }
    }
    @media (min-width: 1024px) {
      #logs-full, #system-logs { max-height: 55vh; }
      .form-grid { gap: 1rem; }
    }
  </style>
</head>
<body class="min-h-screen">
  <div class="page-shell">
    <!-- Header -->
    <div class="header-bar">
      <div class="header-brand">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h1 class="text-xl sm:text-2xl lg:text-3xl font-bold text-sky-400 tracking-tight">Smart Money Copy Bot</h1>
          <span id="app-version" class="text-[10px] sm:text-xs text-slate-500 font-mono whitespace-nowrap has-tip" title="App version and last update">v—</span>
        </div>
        <p class="text-slate-500 text-xs sm:text-sm mt-0.5">Pump.fun · migrations · anti-rug · snipers</p>
      </div>
      <div class="settings-menu-wrap" id="settings-menu-wrap">
        <button type="button" id="settings-btn" class="settings-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="settings-dropdown" title="Settings — Smart Wallets, Config, Backtester, and Logs" onclick="toggleSettingsMenu(event)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/>
            <path d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H5a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.9 1.01 1.51 1H19a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>
          </svg>
          <span class="sr-only">Settings</span>
        </button>
        <div id="settings-dropdown" class="settings-dropdown" role="menu" aria-label="Settings">
          <button type="button" role="menuitem" data-settings-tab="wallets" onclick="showTab('wallets')" title="Discover, search, and manage smart wallets you copy">
            <span class="settings-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
            Smart Wallets
          </button>
          <button type="button" role="menuitem" data-settings-tab="config" onclick="showTab('config')" title="Trade size, TP/SL, anti-rug filters, strategy toggles, risk, and MEV">
            <span class="settings-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 13.5a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V19a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H5a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V5a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.9 1.01 1.51 1H19a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg></span>
            Config
          </button>
          <button type="button" role="menuitem" data-settings-tab="backtester" onclick="showTab('backtester')" title="Simulate strategies on historical launches with filters and charts">
            <span class="settings-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 16v-5"/><path d="M12 16V8"/><path d="M16 16v-3"/></svg></span>
            Backtester
          </button>
          <button type="button" role="menuitem" data-settings-tab="logs" onclick="showTab('logs')" title="Trade events and system/API error logs for debugging">
            <span class="settings-item-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg></span>
            Logs
          </button>
        </div>
      </div>
      <div class="header-actions card status-bar">
        <div class="status-meta">
          <span id="run-status" class="run-status run-running has-tip" title="Whether the copy-trading monitor is actively polling wallets">
            <span id="status-dot" class="dot dot-running" aria-hidden="true"></span>
            <svg id="run-status-icon" class="status-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            <strong id="status-text">Running</strong>
          </span>
          <span id="mode-badge" class="badge badge-livesim status-badge has-tip" title="PAPER = basic sim. LIVE SIM = paper ledger + live market data / live filters (no real funds). LIVE = real swaps.">
            <svg id="mode-badge-icon" class="status-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10"/></svg>
            <span id="mode-badge-label">LIVE SIM</span>
          </span>
          <span id="header-risk-badge" class="risk-badge risk-badge-medium has-tip" data-risk-badge title="Risk On/Off sets the base risk appetite">
            <svg class="status-ico risk-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
            <span class="risk-badge-label">On</span>
          </span>
          <span class="status-stat has-tip" title="Total equity = Available Balance + Positions Value">Eq <strong id="header-equity">—</strong></span>
          <span class="status-stat has-tip" title="Available SOL not locked in open trades">Avail <strong id="balance">—</strong></span>
          <span class="status-stat has-tip" title="Realized PnL for the current UTC day">Day <strong id="daily-pnl">—</strong></span>
          <span class="status-stat rpc-status rpc-unknown hidden sm:inline has-tip" id="rpc-status-wrap" title="Active Solana RPC endpoint label">
            <svg id="rpc-health-icon" class="status-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            RPC <strong id="rpc-active">—</strong>
          </span>
          <span class="status-stat hidden md:inline has-tip" title="Last measured RPC latency"><strong id="rpc-latency">—</strong></span>
        </div>
        <div class="status-controls">
          <button id="btn-pause" class="btn btn-warning" onclick="togglePause()" title="Pause or resume the monitor without shutting down the bot">Pause</button>
          <button id="mode-paper" onclick="setMode('paper')" class="btn btn-secondary" title="Paper trading — virtual fills, optional live marks">Paper</button>
          <button id="mode-liveSimulation" onclick="setMode('liveSimulation')" class="btn btn-primary" title="Live Simulation — same filters as live, virtual fills, forced live market data. No real funds.">Live Sim</button>
          <button id="mode-live" onclick="setMode('live')" class="btn btn-secondary" title="Switch to live trading — real SOL will be spent. Confirm carefully.">Live</button>
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <nav class="nav-tabs" aria-label="Dashboard sections">
      <button data-tab="overview" onclick="showTab('overview', this)" class="btn bg-emerald-600 text-white text-xs sm:text-sm" title="Live ops: balance, risk, positions, signals, migrations">Overview</button>
      <button data-tab="zion" onclick="showTab('zion', this)" class="btn nav-tab-zion text-xs sm:text-sm" title="Zion micro-bot — KOL Token Scanner and manual trade offers"><span class="btn-label-short">Zion</span><span class="btn-label-full">Zion</span></button>
      <button data-tab="microbots" onclick="showTab('microbots', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Trade Profiles, smart-bot lanes, lane fight log, and micro-bot tuning"><span class="btn-label-short">Bots</span><span class="btn-label-full">Micro Bots</span></button>
      <button data-tab="trades" onclick="showTab('trades', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Open and closed trades, recent signals, and migrations — mobile-friendly list view">Trades</button>
      <button data-tab="signals" onclick="showTab('signals', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Live Pump.fun activity, buy signals, and sizing detail"><span class="btn-label-short">Signals</span><span class="btn-label-full">Signals</span></button>
      <button data-tab="scanner" onclick="showTab('scanner', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Market Scanner live feed and configuration"><span class="btn-label-short">Scanner</span><span class="btn-label-full">Scanner</span></button>
      <button data-tab="settings" onclick="showTab('settings', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Risk level, module groups, presets, and strategy JSON import/export">Settings</button>
    </nav>

    <!-- ========== TAB: Overview ========== -->
    <section data-tab-panel="overview" class="space-y-4">
      <div class="active-profile-banner tone-medium" data-active-profile id="active-profile-overview" title="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually.">
        <div class="active-profile-main">
          <span class="active-profile-kicker">Active Profile</span>
          <span class="risk-badge risk-badge-medium" data-risk-badge title="Risk Level">
            <svg class="status-ico risk-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
            <span class="risk-badge-label">On</span>
          </span>
          <span class="active-profile-extras" aria-label="Mode and run status">
            <span class="run-status run-running has-tip" data-run-status title="Monitor run status">
              <span class="dot dot-running" data-run-dot aria-hidden="true"></span>
              <svg class="status-ico" data-run-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              <strong data-run-label>Running</strong>
            </span>
            <span class="badge badge-livesim status-badge has-tip" data-mode-status title="Trading mode">
              <svg class="status-ico" data-mode-icon viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10"/></svg>
              <span data-mode-label>LIVE SIM</span>
            </span>
            <span id="market-session-badge" class="badge status-badge has-tip" title="Current UTC market session" style="background:#1e293b;border:1px solid #334155;color:#94a3b8">
              <span id="market-session-label">Session —</span>
            </span>
          </span>
          <span class="tip tip-below" tabindex="0" data-tip="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually."></span>
        </div>
        <p class="active-profile-hint">Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually.</p>
      </div>
      <div class="card" style="padding:0.65rem 0.85rem">
        <div class="flex flex-wrap gap-2 items-center justify-between mb-1">
          <div class="mint text-xs uppercase tracking-wide" style="color:#94a3b8">Active trade profiles</div>
          <span class="mint text-xs" id="trade-profiles-master-status">—</span>
        </div>
        <div class="trade-profiles-active" id="trade-profiles-active-chips">Loading…</div>
      </div>
      <div class="ov-equity-panel" id="ov-equity-panel" title="Available moves into Positions when you open a trade; marks update Unrealized continuously; closes credit Available and Realized.">
        <div class="ov-equity-main" style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem">
          <div>
            <div class="ov-equity-label">Total Equity <span class="tip tip-below" tabindex="0" data-tip="Available Balance + Positions Value. Most accurate view of portfolio worth across Paper, Live Sim, and Live."></span></div>
            <div class="ov-equity-value" id="ov-equity">—<span class="ov-unit">SOL</span></div>
          </div>
          <div class="ov-reset-wrap">
            <div class="ov-reset-meta" id="ov-reset-meta" title="Time since last Overview Reset">
              <div class="ov-reset-elapsed" id="ov-reset-elapsed">—</div>
              <div class="ov-reset-at" id="ov-reset-at">Never reset</div>
            </div>
            <button type="button" class="btn btn-secondary text-xs" id="btn-dashboard-reset" onclick="resetDashboardSession()" title="Clear balance, trades, PnL, signals, and soak stats for a fresh module test. Does not change Risk or modules.">Reset</button>
          </div>
        </div>
        <div class="ov-equity-rows">
          <div class="ov-equity-row">
            <div class="ov-equity-cell">
              <span class="lbl">Available <span class="tip" tabindex="0" data-tip="SOL not in open trades — cash ready for new buys."></span></span>
              <strong id="ov-available">—</strong>
            </div>
            <div class="ov-equity-cell">
              <span class="lbl">Positions <span class="tip" tabindex="0" data-tip="Current market value of all open positions (updates with price)."></span></span>
              <strong id="ov-positions-val">—</strong>
            </div>
            <div class="ov-equity-cell">
              <span class="lbl">Open <span class="tip" tabindex="0" data-tip="Number of open positions."></span></span>
              <strong id="open-count">—</strong>
            </div>
          </div>
          <div class="ov-equity-row">
            <div class="ov-equity-cell">
              <span class="lbl">Unrealized <span class="tip" tabindex="0" data-tip="Open-position profit/loss vs cost, using live marks."></span></span>
              <strong id="stat-unrealized">—</strong>
            </div>
            <div class="ov-equity-cell">
              <span class="lbl">Realized <span class="tip" tabindex="0" data-tip="Profit/loss from closed trades (all-time in this ledger)."></span></span>
              <strong id="stat-pnl">—</strong>
            </div>
            <div class="ov-equity-cell">
              <span class="lbl">Daily <span class="tip" tabindex="0" data-tip="Realized PnL for the current UTC day."></span></span>
              <strong id="ov-daily-mirror">—</strong>
            </div>
          </div>
        </div>
        <div class="mint text-xs" id="stat-unrealized-hint" style="display:none">—</div>
        <div class="mint text-xs" id="stat-return" style="display:none">—</div>
        <div class="mint text-xs" id="ov-balance-mirror" style="display:none">—</div>
      </div>

      <div class="ov-meta-strip mt-2.5 sm:mt-3">
        <div class="card">
          <div class="stat-label">Win Rate <span class="tip tip-below" tabindex="0" data-tip="Percentage of closed trades that finished green."></span></div>
          <div class="stat" id="win-rate">—</div>
          <div class="mint mt-1 text-xs" id="stat-wl">—</div>
        </div>
        <div class="card">
          <div class="stat-label">Max DD <span class="tip tip-below" tabindex="0" data-tip="Worst peak-to-trough equity drop across closed trades."></span></div>
          <div class="stat" id="stat-maxdd">—</div>
          <div class="mint mt-1 text-xs" id="stat-avg-hold">—</div>
        </div>
        <div class="card">
          <div class="stat-label">Wallets <span class="tip tip-below" tabindex="0" data-tip="Watching = polled for copy signals. Tracked = total imported smart wallets."></span></div>
          <div class="text-lg font-semibold" id="watched">—</div>
          <div class="mint mt-1 text-xs" id="watched-sub">—</div>
        </div>
        <div class="card">
          <div class="stat-label">Signals <span class="tip tip-below" tabindex="0" data-tip="Wallet buy signals recorded in the last 24 hours."></span></div>
          <div class="text-lg font-semibold" id="signals">—</div>
          <div class="signal-light mt-1.5" id="signal-light" title="Green = recent wallet-buy. Amber = quiet/paused. Red = stopped / no wallets / RPC down.">
            <span class="dot dot-quiet" id="signal-light-dot"></span>
            <span id="signal-light-label">—</span>
          </div>
        </div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3 mt-2.5 sm:mt-3">
        <div class="card !py-3"><div class="stat-label">Trades <span class="tip tip-below" tabindex="0" data-tip="Open + closed paper/live trades."></span></div><div class="text-lg font-semibold" id="stat-trades">—</div></div>
        <div class="card !py-3"><div class="stat-label">Trade Rate <span class="tip tip-below" tabindex="0" data-tip="Buys in the last hour vs selective cap."></span></div><div class="text-lg font-semibold" id="stat-trade-rate">—</div></div>
        <div class="card !py-3 col-span-2"><div class="stat-label">Status <span class="tip tip-below" tabindex="0" data-tip="Short health summary: monitor state, mode, and key blockers."></span></div><div class="text-sm text-slate-300 break-words" id="stat-detail">—</div></div>
      </div>

      <div class="card mt-2.5 sm:mt-3" id="lane-fight-overview-card">
        <div class="section-title" style="margin-bottom:0.35rem">Lane fight log</div>
        <p class="text-xs text-slate-500 mb-1">Smart Bot micro-lane pass/fail. Shows winner, opened vs no-buy after cascade.</p>
        <div class="tp-decisions lane-decisions" id="lane-decisions-overview"><span class="mint">No lane fights yet</span></div>
      </div>

      <div class="card card-open-positions" id="open-positions-panel">
        <div class="section-title-open">
          <div class="title-left">
            <span class="title-text">Open Positions</span>
            <span class="tip" tabindex="0" data-tip="Active holdings with buy MC, live MC, original/remaining size (SOL + USD), partial take-profit progress, converging wallets, 1h volume, unrealized PnL, trailing stop, TP/SL, and Reason → More Info (profile assignment, entry path, MC, technicals, wallets, quality 0–100). Use Sell to force-close."></span>
          </div>
          <div class="title-right">
            <span class="pos-count-badge" id="open-positions-badge" data-empty="1">0 open</span>
            <button type="button" class="danger sell-all-btn" id="sell-all-open" hidden disabled onclick="forceSellAllPositions()" title="Force sell all open positions">Sell All</button>
          </div>
        </div>
        <div class="closed-filter mb-2 open-profile-filter" role="group" aria-label="Filter open positions by profile" style="margin-top:0.35rem"></div>
        <div class="positions-scroll">
          <table id="positions-table">
            <thead><tr><th>Token</th><th>Profile</th><th>Name</th><th>Mint</th><th>Buy MC</th><th>Live MC</th><th>Cost</th><th>Wallets</th><th>1h vol</th><th>PnL</th><th>Trailing stop</th><th>TP / SL</th><th>Reason</th><th>Opened</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div id="pos-more-info-float" role="tooltip" aria-hidden="true"></div>

      <div class="card card-closed-trades" id="closed-trades-panel">
        <div class="closed-trades-head">
          <div class="section-title">Closed Trades <span class="tip" tabindex="0" data-tip="Finished trades grouped by entry. Expand a row to see each partial take-profit and the final exit. Hover or tap Reason → More Info for a side-by-side Open vs Exit breakdown. Buy/exit MC, buy-in, wallet, and total PnL are for the full trade. Filter by profitable, losing, or trade profile."></span></div>
          <div class="closed-filter" role="group" aria-label="Filter closed trades by result">
            <button type="button" class="closed-filter-btn is-active" data-closed-filter="all" onclick="setClosedTradesFilter('all')" aria-pressed="true">All</button>
            <button type="button" class="closed-filter-btn" data-closed-filter="profit" onclick="setClosedTradesFilter('profit')" aria-pressed="false">Profitable</button>
            <button type="button" class="closed-filter-btn" data-closed-filter="loss" onclick="setClosedTradesFilter('loss')" aria-pressed="false">Losing</button>
          </div>
        </div>
        <div class="closed-filter mb-2 closed-profile-filter" id="closed-profile-filter" role="group" aria-label="Filter closed trades by profile" style="margin-top:0.35rem"></div>
        <div class="closed-trades-scroll">
          <table id="closed-table">
            <thead><tr><th>Token</th><th>Profile</th><th>Name</th><th>Mint</th><th>Buy MC</th><th>Exit MC</th><th>Buy-in</th><th>Wallet</th><th>PnL</th><th>Reason</th><th>Closed</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Recent Signals <span class="tip" tabindex="0" data-tip="Latest wallet buys and bot reactions (copy, skip, anti-rug block)."></span></div>
          <div id="activity" class="max-h-72 overflow-y-auto text-sm"></div>
        </div>
        <div class="card">
          <div class="section-title">Market Scanner <span class="tip" tabindex="0" data-tip="Autonomous TA / Pump.fun / Dex candidates (no wallet required). Configure on the Scanner tab, or toggle via Settings → Market Scanner (TA). Hybrid when wallets also buy the same mint."></span></div>
          <div id="scanner-status" data-scanner-status class="mint text-xs mb-2">—</div>
          <div id="scanner-feed" data-scanner-feed class="max-h-72 overflow-y-auto text-sm"></div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Cumulative PnL <span class="tip" tabindex="0" data-tip="Running equity curve from closed trades over time."></span></div>
          <div class="chart-wrap"><canvas id="chart-cumulative"></canvas></div>
          <div class="chart-empty" id="chart-cumulative-empty" style="display:none">No closed trades yet</div>
        </div>
        <div class="grid gap-3 sm:gap-4">
          <div class="card">
            <div class="section-title">By Wallet <span class="tip" tabindex="0" data-tip="PnL attributed to each smart wallet that triggered your copies."></span></div>
            <div class="chart-wrap" style="height:160px"><canvas id="chart-wallet"></canvas></div>
            <div class="chart-empty" id="chart-wallet-empty" style="display:none">No wallet trades yet</div>
          </div>
          <div class="card">
            <div class="section-title">Win / Loss <span class="tip" tabindex="0" data-tip="Count of winning vs losing closed trades."></span></div>
            <div class="chart-wrap" style="height:160px"><canvas id="chart-winloss"></canvas></div>
            <div class="chart-empty" id="chart-winloss-empty" style="display:none">No closed trades yet</div>
          </div>
        </div>
      </div>

      <div class="grid sm:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Paper Funding <span class="tip" tabindex="0" data-tip="Add simulated SOL, reset paper balance, or wipe paper history. Does not affect live wallets."></span></div>
          <div class="filters-row">
            <div class="ctl ctl-md">
              <span>Amount (SOL) <span class="tip" tabindex="0" data-tip="How much paper SOL to add when you Top Up."></span></span>
              <input type="number" id="paper-topup-amount" min="0.01" step="0.1" value="1" />
            </div>
            <button class="btn btn-primary" onclick="paperTopUp()" title="Add the amount above to your paper balance">Top Up</button>
            <button class="btn btn-warning" onclick="paperReset(false)" title="Reset paper balance to starting amount; keep trade history">Reset</button>
            <button class="btn btn-danger" onclick="paperReset(true)" title="Wipe paper balance AND trade history">Full Reset</button>
          </div>
          <div class="mint mt-2" id="paper-fund-status"></div>
        </div>
        <div class="card">
          <div class="section-title">Migrations / Re-Entry <span class="tip" tabindex="0" data-tip="Pump.fun graduations and post-exit re-entry watches (profit-dip + stop-loss reclaim)."></span></div>
          <div class="mint mb-2" id="mig-live-status">WS: —</div>
          <div id="migrations" class="max-h-28 overflow-y-auto text-sm mb-2"></div>
          <div class="mint" id="rebuy-status">—</div>
        </div>
      </div>
    </section>

    <!-- ========== TAB: Trades (open / closed / signals / migrations) ========== -->
    <section data-tab-panel="trades" class="hidden space-y-4">
      <div class="profile-colour-legend" data-profile-legend role="region" aria-label="Profile colour legend">
        <div class="profile-colour-legend-head">
          <span class="profile-colour-legend-title">Profile colours</span>
          <span class="profile-colour-legend-hint">Same colours on badges &amp; filters</span>
        </div>
        <div class="profile-colour-legend-items" data-profile-legend-items></div>
      </div>
      <div class="card card-open-positions" id="trades-open-positions-panel">
        <div class="section-title-open">
          <div class="title-left">
            <span class="title-text">Open Trades</span>
            <span class="tip" tabindex="0" data-tip="Active holdings with buy MC, live MC, original/remaining size, partial take-profit progress, converging wallets, 1h volume, unrealized PnL on remaining size, trailing stop, take-profit, and stop-loss. Coloured profile badges show which strategy owns each trade. Filter by profile below. Same data as Overview Open Positions."></span>
          </div>
          <div class="title-right">
            <span class="pos-count-badge" id="trades-open-positions-badge" data-empty="1">0 open</span>
            <button type="button" class="danger sell-all-btn" id="trades-sell-all-open" hidden disabled onclick="forceSellAllPositions()" title="Force sell all open positions">Sell All</button>
          </div>
        </div>
        <div class="closed-filter mb-2 open-profile-filter" id="open-profile-filter" role="group" aria-label="Filter open trades by profile" style="margin-top:0.35rem"></div>
        <div class="positions-scroll">
          <table id="trades-positions-table">
            <thead><tr><th>Token</th><th>Profile</th><th>Name</th><th>Mint</th><th>Buy MC</th><th>Live MC</th><th>Cost</th><th>Wallets</th><th>1h vol</th><th>PnL</th><th>Trailing stop</th><th>TP / SL</th><th>Reason</th><th>Opened</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div class="card card-closed-trades" id="trades-closed-trades-panel">
        <div class="closed-trades-head">
          <div class="section-title">Closed Trades <span class="tip" tabindex="0" data-tip="Finished trades grouped by entry. Expand a row to see each partial take-profit and the final exit. Hover or tap Reason → More Info for a side-by-side Open vs Exit breakdown. Buy/exit MC, buy-in, wallet, and total PnL are for the full trade. Filter by profitable, losing, or trade profile."></span></div>
          <div class="closed-filter" role="group" aria-label="Filter closed trades by result">
            <button type="button" class="closed-filter-btn is-active" data-closed-filter="all" onclick="setClosedTradesFilter('all')" aria-pressed="true">All</button>
            <button type="button" class="closed-filter-btn" data-closed-filter="profit" onclick="setClosedTradesFilter('profit')" aria-pressed="false">Profitable</button>
            <button type="button" class="closed-filter-btn" data-closed-filter="loss" onclick="setClosedTradesFilter('loss')" aria-pressed="false">Losing</button>
          </div>
        </div>
        <div class="closed-filter mb-2 closed-profile-filter" role="group" aria-label="Filter closed trades by profile" style="margin-top:0.35rem"></div>
        <div class="closed-trades-scroll">
          <table id="trades-closed-table">
            <thead><tr><th>Token</th><th>Profile</th><th>Name</th><th>Mint</th><th>Buy MC</th><th>Exit MC</th><th>Buy-in</th><th>Wallet</th><th>PnL</th><th>Reason</th><th>Closed</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Recent Signals <span class="tip" tabindex="0" data-tip="Latest wallet buys and bot reactions (copy, skip, anti-rug block)."></span></div>
        <div id="trades-activity" class="max-h-72 overflow-y-auto text-sm"></div>
      </div>

      <div class="card">
        <div class="section-title">Migrations / Re-Entry <span class="tip" tabindex="0" data-tip="Pump.fun graduations and post-exit re-entry watches (profit-dip + stop-loss reclaim)."></span></div>
        <div class="mint mb-2" id="trades-mig-live-status">WS: —</div>
        <div id="trades-migrations" class="max-h-40 overflow-y-auto text-sm mb-2"></div>
        <div class="mint" id="trades-rebuy-status">—</div>
      </div>
    </section>

    <!-- ========== TAB: Smart Wallets ========== -->
    <section data-tab-panel="wallets" class="hidden space-y-4">
      <div class="card">
        <div class="flex flex-wrap gap-2 items-center justify-between mb-2">
          <div class="section-title !mb-0">Monitor &amp; Discovery <span class="tip" tabindex="0" data-tip="Force Refresh re-enables tracked wallets and restarts the poll loop. Discovery status shows API health for GMGN/Kolscan/Birdeye."></span></div>
          <div class="flex flex-wrap gap-2 items-center">
            <button class="btn btn-primary" onclick="forceRefreshMonitoring()" title="Re-enable all tracked wallets and re-subscribe the poll loop">Force Refresh Monitoring</button>
            <button class="btn btn-secondary" onclick="refreshDiscoveryStatus()" title="Poll discovery health without starting a full search">Refresh status</button>
            <span class="mint" id="discovery-status">—</span>
          </div>
        </div>
        <div class="mint text-sm mb-2" id="discovery-sources-status">Sources — checking…</div>
        <div class="mint text-amber-300 text-sm mb-1 hidden" id="discovery-setup-hint" style="display:none;color:#fbbf24"></div>
        <div class="mint text-amber-300 text-sm mb-2 hidden" id="birdeye-setup-hint" style="display:none;color:#fbbf24"></div>
        <div class="mint text-xs mb-2" id="birdeye-key-status">—</div>
        <div class="filters-row">
          <label class="ctl ctl-md">
            <span>Auto-refresh (min) <span class="tip" tabindex="0" data-tip="How often to refresh top smart wallets in the background. 0 = disabled."></span></span>
            <input type="number" id="disc-auto-min" value="15" min="0" max="120" />
          </label>
          <button class="btn btn-secondary" onclick="saveDiscoveryConfig()" title="Save the auto-refresh interval">Save interval</button>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Wallet Search <span class="tip" tabindex="0" data-tip="Filter the smart-wallet pool by win rate, trade frequency, recent activity, Pump.fun focus, and sniper risk."></span></div>
        <div class="filters-row mb-3">
          <input type="search" id="wallet-search-q" placeholder='Search e.g. "active scalpers"' class="search-q" title="Free-text intent: scalpers, pump, active, or wallet name fragments" />
          <label class="ctl ctl-sm">
            <span>Win% ≥ <span class="tip" tabindex="0" data-tip="Minimum historical win rate required."></span></span>
            <input type="number" id="search-min-win" value="45" min="0" max="100" />
          </label>
          <label class="ctl ctl-sm">
            <span>Trades 7d ≥ <span class="tip" tabindex="0" data-tip="Minimum trades in the last 7 days — higher = more active scalpers."></span></span>
            <input type="number" id="search-min-trades" value="20" min="0" />
          </label>
          <label class="ctl ctl-sm">
            <span>Activity ≤ days <span class="tip" tabindex="0" data-tip="Only wallets that traded within this many days."></span></span>
            <input type="number" id="search-max-days" value="7" min="1" max="30" />
          </label>
          <label class="ctl ctl-sm">
            <span>Max sniper <span class="tip" tabindex="0" data-tip="Exclude wallets tagged as heavy snipers above this score (0–100)."></span></span>
            <input type="number" id="search-max-sniper" value="50" min="0" max="100" />
          </label>
          <label class="ctl-check" title="Prefer wallets with Pump.fun / migration history"><input type="checkbox" id="search-pump-focus" /> Pump.fun</label>
          <label class="ctl-check" title="Only high-frequency traders (scalpers)"><input type="checkbox" id="search-scalper-only" /> Scalpers only</label>
          <button class="btn btn-primary" onclick="searchWallets()" title="Run search with the filters above">Search</button>
          <button class="btn btn-secondary" onclick="suggestScalpers()" title="One-click: active wallets with high 7d trade count and solid win rate">Suggest scalpers</button>
          <span class="mint self-center" id="search-status"></span>
        </div>
        <div class="overflow-x-auto">
          <table id="search-wallets-table">
            <thead><tr><th>Name</th><th>Address</th><th title="Time since last known trade">Last</th><th title="Win rate %">Win%</th><th title="Trades in last 7 days">7d</th><th title="Trades in last 30 days">30d</th><th title="Pump.fun trades when reported (never estimated)">Pump</th><th></th></tr></thead>
            <tbody><tr><td colspan="8" class="text-slate-500">Search or suggest scalpers</td></tr></tbody>
          </table>
        </div>
        <div id="scalper-suggestions" class="mt-3 hidden">
          <div class="mint mb-2">Auto-suggest: consistent scalpers <span class="tip" tabindex="0" data-tip="Quick-add chips for wallets that look like consistent high-frequency scalpers."></span></div>
          <div id="scalper-chips" class="flex flex-wrap gap-2"></div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Discover Smart Wallets <span class="tip" tabindex="0" data-tip="Pull candidate wallets from Kolscan, GMGN, Birdeye, DexScreener, or curated lists. Use All sources when GMGN is blocked."></span></div>
        <div class="filters-row mb-3">
          <label class="ctl ctl-lg">
            <span>Source <span class="tip" tabindex="0" data-tip="All = merge every source. Kolscan works without API keys. Birdeye needs BIRDEYE_API_KEY."></span></span>
            <select id="discover-source" onchange="onDiscoverSourceChange()">
              <option value="all">All sources (best)</option>
              <option value="kolscan">Kolscan leaderboard</option>
              <option value="axiom">Axiom (Solana Tracker)</option>
              <option value="photon">Photon (Solana Tracker)</option>
              <option value="bullx">BullX (offline)</option>
              <option value="gmgn">GMGN</option>
              <option value="birdeye">Birdeye</option>
              <option value="dexscreener">DexScreener flows</option>
              <option value="manual">Manual / curated</option>
              <option value="pump">Pump.fun smart money</option>
            </select>
          </label>
          <label class="ctl ctl-md">
            <span>Period <span class="tip" tabindex="0" data-tip="Leaderboard window for PnL / activity ranking."></span></span>
            <select id="discover-period">
              <option value="7d">7D</option>
              <option value="30d" selected>30D</option>
            </select>
          </label>
          <label class="ctl ctl-sm">
            <span>Limit <span class="tip" tabindex="0" data-tip="Max candidates to return (20–100)."></span></span>
            <select id="discover-limit">
              <option value="20">20</option>
              <option value="30">30</option>
              <option value="40">40</option>
              <option value="50">50</option>
              <option value="75">75</option>
              <option value="100" selected>100</option>
            </select>
          </label>
          <label class="ctl ctl-sm">
            <span>Min win % <span class="tip" tabindex="0" data-tip="Drop wallets below this win rate when the source supports it."></span></span>
            <input type="number" id="discover-min-wr" value="35" min="0" max="100" />
          </label>
          <label class="ctl ctl-sm">
            <span>Min trades 7d <span class="tip" tabindex="0" data-tip="Prefer wallets that traded at least this many times recently."></span></span>
            <input type="number" id="discover-min-trades" value="15" min="0" />
          </label>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl-check" title="Bias results toward Pump.fun / early-curve traders"><input type="checkbox" id="discover-pump" /> Pump.fun focus</label>
          <label class="ctl-check" title="Sort high 7d trade-count wallets first"><input type="checkbox" id="discover-scalpers" checked /> Prefer scalpers</label>
          <label class="ctl-check" title="Hide wallets with more than 1000 trades in 7d or 30d (noise / bots)"><input type="checkbox" id="discover-exclude-hf" checked /> Exclude high-freq (&gt;1000 trades 7d/30d)</label>
          <button class="btn btn-primary" onclick="discoverWallets(false)" title="Run discovery (may use cache)">Discover</button>
          <button class="btn btn-secondary" onclick="discoverWallets(true)" title="Bypass cache and re-fetch all sources">Force refresh</button>
          <button class="btn btn-secondary" onclick="importDiscoveredAll()" title="Add every new (untracked) candidate to Tracked Smart Wallets">Import all new</button>
          <button class="btn btn-primary" onclick="importFavourites()" title="One-click: discover favourites presets (30D / 100 / min win 35% / min 15 trades 7d / scalpers / exclude HF) from All + Kolscan + Axiom + Photon + Nansen seed JSON, then track new wallets">Import Favourites</button>
          <span class="mint self-center" id="discover-status"></span>
          <span class="mint self-center" id="discover-key-status"></span>
        </div>
        <div class="mint mb-2" id="discover-related"></div>
        <div id="discover-empty" class="hidden mb-3" style="padding:12px;border:1px dashed #334155;border-radius:8px;background:#0f172a">
          <div class="font-medium mb-1" style="color:#f87171">No wallets found</div>
          <div class="mint mb-2" id="discover-empty-msg">Try another source or add wallets manually.</div>
          <ul class="mint text-sm mb-2" style="margin-left:1.1rem;list-style:disc">
            <li>Switch source to <b>All sources</b> or <b>Kolscan</b> (works when GMGN is blocked)</li>
            <li>Lower Min win % / Min trades, or uncheck Pump.fun focus</li>
            <li>Add a <b>BIRDEYE_API_KEY</b> in .env for Birdeye traders</li>
            <li>Paste addresses below and click <b>Add manual</b></li>
          </ul>
          <div class="flex flex-wrap gap-2">
            <button class="btn btn-secondary" onclick="discoverWallets(true)">Refresh</button>
            <button class="btn btn-secondary" onclick="document.getElementById('discover-source').value='all';discoverWallets(true)">Try All sources</button>
            <button class="btn btn-secondary" onclick="document.getElementById('discover-manual-text').focus()">Manual add</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table id="discover-wallets-table">
            <thead>
              <tr>
                <th>Name</th>
                <th title="Which API or list provided this wallet">Src</th>
                <th>Address</th>
                <th title="Time since last known trade">Last</th>
                <th title="Win rate %">Win%</th>
                <th title="Trades in last 7 days">7d</th>
                <th title="Trades in last 30 days">30d</th>
                <th title="Pump.fun trades when reported (never estimated)">Pump</th>
                <th title="0–100 smart-flow strength score">Flow</th>
                <th></th>
              </tr>
            </thead>
            <tbody><tr><td colspan="10" class="text-slate-500">Choose a source and click Discover</td></tr></tbody>
          </table>
        </div>
        <div class="mt-3" id="discover-manual-box">
          <div class="mint mb-1">Manual add (Name:Address or raw address — one per line) <span class="tip" tabindex="0" data-tip="Paste Solana addresses to import. Format: Name:Address or address alone."></span></div>
          <textarea id="discover-manual-text" rows="2" placeholder="Cented:CyaE1Vxv…&#10;Bi4rd5FH…"></textarea>
          <div class="flex flex-wrap gap-2 mt-2">
            <button class="btn btn-primary" onclick="addManualDiscovered()" title="Parse the box and add wallets to tracking">Add manual</button>
            <button class="btn btn-secondary" onclick="document.getElementById('discover-source').value='manual';discoverWallets(true)" title="Show the offline curated candidate list">Load curated list</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="flex flex-wrap gap-2 items-center justify-between mb-2">
          <div class="section-title !mb-0">Nansen.ai Smart Money <span class="tip" tabindex="0" data-tip="Fetch labeled Smart Money wallets on Solana via Nansen (Smart Trader / 30D / 90D / Fund). Each Discover costs ~5 credits. Export to CSV/JSON so you can re-import without spending credits while testing."></span></div>
          <span class="mint" id="nansen-key-status">—</span>
        </div>
        <div class="mint text-sm mb-2" id="nansen-credit-hint">Presets use Smart Trader + 30D/90D labels for higher win-rate / PnL wallets. Enrich PnL is optional (~1 credit per wallet).</div>
        <div class="filters-row mb-3">
          <label class="ctl ctl-lg">
            <span>Filter preset <span class="tip" tabindex="0" data-tip="Recommended: Best overall. High win-rate recent uses 30D+90D Smart Trader labels."></span></span>
            <select id="nansen-preset" onchange="onNansenPresetChange()" title="Suggested Smart Money filter presets">
              <option value="best_overall">Best overall (recommended)</option>
              <option value="high_win_recent">High win-rate recent (30D/90D)</option>
              <option value="proven_long_term">Proven long-term</option>
              <option value="funds">Funds only</option>
              <option value="active_traders">Most active (24h)</option>
              <option value="custom">Custom labels</option>
            </select>
          </label>
          <label class="ctl ctl-sm">
            <span>Min trade $ <span class="tip" tabindex="0" data-tip="Ignore dust trades below this USD size."></span></span>
            <input type="number" id="nansen-min-usd" value="500" min="0" step="100" />
          </label>
          <label class="ctl ctl-sm">
            <span>Limit <span class="tip" tabindex="0" data-tip="Max unique wallets after aggregating 24h trades."></span></span>
            <select id="nansen-limit">
              <option value="20">20</option>
              <option value="30">30</option>
              <option value="40">40</option>
              <option value="50" selected>50</option>
              <option value="75">75</option>
              <option value="100">100</option>
            </select>
          </label>
        </div>
        <div class="filters-row mb-3" id="nansen-label-row">
          <span class="mint self-center text-xs">Labels:</span>
          <label class="ctl-check" title="Historically profitable traders"><input type="checkbox" class="nansen-label" value="Smart Trader" checked /> Smart Trader</label>
          <label class="ctl-check" title="Top performers over 30 days"><input type="checkbox" class="nansen-label" value="30D Smart Trader" checked /> 30D</label>
          <label class="ctl-check" title="Top performers over 90 days"><input type="checkbox" class="nansen-label" value="90D Smart Trader" checked /> 90D</label>
          <label class="ctl-check" title="Top performers over 180 days"><input type="checkbox" class="nansen-label" value="180D Smart Trader" /> 180D</label>
          <label class="ctl-check" title="Institutional funds"><input type="checkbox" class="nansen-label" value="Fund" /> Fund</label>
        </div>
        <div class="filters-row mb-3">
          <button class="btn btn-primary" onclick="discoverNansen(false)" title="Use cache if fresh (~0 credits), else fetch (~5 credits)">Discover</button>
          <button class="btn btn-secondary" onclick="discoverNansen(true)" title="Bypass cache and call Nansen API (~5 credits)">Force refresh (~5 cr)</button>
          <button class="btn btn-secondary" onclick="enrichNansenSelected()" title="Fetch win rate / PnL for checked rows (~1 credit each, max 10)">Enrich PnL selected</button>
          <button class="btn btn-secondary" onclick="importNansenSelected()" title="Add checked wallets to Tracked Smart Wallets">Import selected</button>
          <button class="btn btn-secondary" onclick="importNansenAllNew()" title="Import every new (untracked) wallet in the table">Import all new</button>
          <button class="btn btn-secondary" onclick="exportNansen('csv')" title="Download current list as CSV (no credits)">Export CSV</button>
          <button class="btn btn-secondary" onclick="exportNansen('json')" title="Download current list as JSON (no credits)">Export JSON</button>
          <span class="mint self-center" id="nansen-status"></span>
        </div>
        <div class="filters-row mb-3">
          <input type="file" id="nansen-import-file" accept=".csv,.json,text/csv,application/json" class="text-xs" title="Import a previously exported Nansen wallet list" />
          <button class="btn btn-secondary" onclick="importNansenFile()" title="Load CSV/JSON into the table without calling the API">Import CSV/JSON</button>
          <button class="btn btn-secondary" onclick="loadNansenCached()" title="Show last cached / imported list">Load cached</button>
          <span class="mint self-center text-xs" id="nansen-preset-desc">Smart Trader + 30D/90D, min $500</span>
        </div>
        <div class="overflow-x-auto">
          <table id="nansen-wallets-table">
            <thead>
              <tr>
                <th><input type="checkbox" id="nansen-select-all" onchange="toggleNansenSelectAll(this.checked)" title="Select all" /></th>
                <th>Address</th>
                <th title="Nansen Smart Money label">Label</th>
                <th title="24h trade count / volume from Smart Money dex-trades">Activity</th>
                <th title="Win rate % (after Enrich PnL)">Win%</th>
                <th title="Realized PnL USD (after Enrich PnL)">PnL</th>
                <th title="Recent token symbols traded">Tokens</th>
                <th></th>
              </tr>
            </thead>
            <tbody><tr><td colspan="8" class="text-slate-500">Choose a preset and click Discover, or import a saved CSV/JSON</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Top Smart Wallets (GMGN quick) <span class="tip" tabindex="0" data-tip="Shortcut to GMGN top PnL wallets. Falls back to curated/Kolscan if GMGN is blocked."></span></div>
        <div class="flex flex-wrap gap-2 items-center mb-3">
          <select id="top-period" title="Rank by 7-day or 30-day PnL">
            <option value="7d">7D PnL</option>
            <option value="30d">30D PnL</option>
          </select>
          <button class="btn btn-primary" onclick="loadTopWallets()" title="Fetch top wallets for the selected period">Load Top</button>
          <button class="btn btn-secondary" onclick="importAllTop()" title="Import all new wallets from the loaded list">Import All New</button>
          <span class="mint" id="top-status"></span>
          <span class="mint" id="gmgn-key-status"></span>
        </div>
        <div class="overflow-x-auto">
          <table id="top-wallets-table">
            <thead><tr><th>Name</th><th>Address</th><th>Win%</th><th>PnL</th><th>7d</th><th>30d</th><th></th></tr></thead>
            <tbody><tr><td colspan="7" class="text-slate-500">Click Load Top Wallets</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="flex flex-wrap gap-2 items-center mb-3">
          <div class="section-title !mb-0 flex-1 min-w-[10rem]">Tracked Smart Wallets <span class="tip" tabindex="0" data-tip="Wallets the bot actually copies. Enable/disable, refresh activity, or prune dead ones."></span></div>
          <button class="btn btn-secondary" onclick="refreshActivity()" title="Update last-active, win rate, and trade counts from GMGN/on-chain"><span class="btn-label-short">Activity</span><span class="btn-label-full">Refresh Activity</span></button>
          <button class="btn btn-secondary" onclick="forceRefreshMonitoring()" title="Re-enable all tracked wallets and kick the monitor poll loop"><span class="btn-label-short">Force Refresh</span><span class="btn-label-full">Force Refresh Monitoring</span></button>
          <button class="btn btn-warning" onclick="pruneInactive()" title="Remove wallets with no activity for more than 14 days"><span class="btn-label-short">Prune</span><span class="btn-label-full">Prune Inactive (&gt;14d)</span></button>
          <button class="btn btn-secondary" onclick="pruneLowQuality()" title="Unwatch/down-weight wallets below quality threshold (confirm to hard-remove)"><span class="btn-label-short">Quality</span><span class="btn-label-full">Prune Low Quality</span></button>
          <button class="btn btn-danger" onclick="resetWalletTracker()" title="Remove ALL tracked smart wallets from the Watch list. Boot will not auto-reload favourites until you click Import Favourites again."><span class="btn-label-short">Reset</span><span class="btn-label-full">Reset Wallet Tracker</span></button>
          <span class="mint" id="gmgn-status"></span>
        </div>
        <div class="mint text-sm mb-2" id="watching-status">Watching — wallets</div>
        <div id="watching-list" class="mint text-xs mb-3 max-h-24 overflow-y-auto" style="color:#94a3b8"></div>
        <div class="overflow-x-auto">
          <table id="wallets-table">
            <thead><tr><th>Name</th><th title="smart / scalper / sniper / kol">Cat</th><th>Address</th><th title="Absolute last trade time + relative label">Last Active</th><th>Win%</th><th title="Quality score 0–100">Q</th><th title="7d / 30d / Pump.fun trades">7d / 30d / Pump</th><th>Status</th><th>Watch</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="mt-4">
          <div class="section-title">Scalper Wallets <span class="tip" tabindex="0" data-tip="Tracked wallets tagged as scalpers (high trade frequency)."></span></div>
          <div class="overflow-x-auto">
            <table id="scalper-wallets-table">
              <thead><tr><th>Name</th><th>Address</th><th>Last Active</th><th>Win%</th><th>7d / 30d</th><th>Status</th><th></th></tr></thead>
              <tbody><tr><td colspan="7" class="text-slate-500">No scalpers tracked yet</td></tr></tbody>
            </table>
          </div>
        </div>
        <form class="filters-row mt-3" id="add-wallet-form" title="Add a single wallet by name + Solana address">
          <input type="text" name="name" placeholder="Wallet name" required class="ctl-md" style="width:9rem" />
          <input type="text" name="address" placeholder="Solana address" required class="search-q" />
          <select name="category" class="ctl-md" title="Category used for grouping and strategy hints">
            <option value="smart">smart</option>
            <option value="scalper">scalper</option>
            <option value="sniper">sniper</option>
            <option value="kol">kol</option>
          </select>
          <button type="submit" class="btn btn-primary" title="Save this wallet to the tracked list">Add Wallet</button>
        </form>
        <div class="mt-3">
          <div class="mint mb-1">Bulk import (addresses or Name:Address, one per line) <span class="tip" tabindex="0" data-tip="Import many wallets at once. Optional category applies to all lines."></span></div>
          <textarea id="bulk-import-text" rows="3" placeholder="CyaE1Vxv...&#10;Theo:Bi4rd5FH..."></textarea>
          <div class="filters-row mt-2">
            <select id="bulk-import-cat" class="ctl-md" title="Force category for all imported lines, or auto-detect">
              <option value="">auto category</option>
              <option value="scalper">scalper</option>
              <option value="smart">smart</option>
              <option value="sniper">sniper</option>
              <option value="kol">kol</option>
            </select>
            <button type="button" class="btn btn-secondary" onclick="bulkImportWallets()" title="Parse and import all valid addresses">Bulk import</button>
            <span class="mint self-center" id="bulk-import-status"></span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Live Trading Wallets <span class="tip" tabindex="0" data-tip="Slots that hold real keys via env vars (main/burner). Private keys never leave the server."></span></div>
        <p class="mint mb-2">Keys stay in env vars — never sent to the browser.</p>
        <div class="flex flex-wrap gap-2 mb-3">
          <button class="btn btn-secondary" onclick="loadTradingWallets()" title="Reload trading wallet slots and balances">Refresh</button>
          <span class="mint" id="live-wallet-status"></span>
        </div>
        <div class="overflow-x-auto">
          <table id="trading-wallets-table">
            <thead><tr><th>Name</th><th title="main = primary, burner = disposable">Role</th><th title="Environment variable that stores the secret key">Env</th><th>Pubkey</th><th>Balance</th><th>Key</th><th></th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <form class="filters-row mt-3" id="add-trading-wallet-form" title="Register a new trading slot that reads its key from an env var">
          <input type="text" name="name" placeholder="Name" required style="width:8rem" />
          <input type="text" name="envVar" placeholder="ENV_VAR" required style="width:10rem" title="Name of the env var containing the base58 secret key" />
          <select name="role" class="ctl-md"><option value="main">main</option><option value="burner">burner</option></select>
          <button type="submit" class="btn btn-primary" title="Add this trading wallet slot">Add Slot</button>
        </form>
      </div>
    </section>

    <!-- ========== TAB: Signals & Trades ========== -->
    <section data-tab-panel="signals" class="hidden space-y-4">
      <div class="card">
        <div class="section-title">Pump.fun Smart Activity <span class="tip" tabindex="0" data-tip="Live early-curve buys, near-migration plays, and smart-money scores on Pump.fun launches."></span></div>
        <div class="filters-row mb-2">
          <label class="ctl ctl-md">
            <span>Filter <span class="tip" tabindex="0" data-tip="Show all events, only early buys, near-migration, migrations, or priority signals."></span></span>
            <select id="pump-act-filter">
              <option value="all">All</option>
              <option value="early">Early buys</option>
              <option value="near">Near migration</option>
              <option value="migration">Migrations</option>
              <option value="priority">Priority only</option>
            </select>
          </label>
          <label class="ctl ctl-sm">
            <span>Min SM <span class="tip" tabindex="0" data-tip="Minimum Birdeye smart-money score (0–100) to show a launch."></span></span>
            <input type="number" id="pump-act-min-sm" value="0" min="0" max="100" />
          </label>
          <button class="btn btn-secondary" onclick="refreshPumpActivity()" title="Reload the activity table">Refresh</button>
          <button class="btn btn-primary" onclick="discoverPumpSmart()" title="Scan for Pump.fun smart wallets and hot launches">Discover Pump SM</button>
          <span class="mint self-center" id="pump-act-status">—</span>
        </div>
        <div class="overflow-x-auto max-h-72 overflow-y-auto">
          <table id="pump-activity-table">
            <thead>
              <tr>
                <th>Token</th>
                <th title="early / near-migration / migration">Kind</th>
                <th title="Bonding curve progress %">Curve</th>
                <th title="Distinct smart wallets seen">Wallets</th>
                <th title="Birdeye smart-money score">Birdeye SM</th>
                <th>Notes</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody><tr><td colspan="7" class="text-slate-500">Waiting for Pump.fun smart wallet activity…</td></tr></tbody>
          </table>
        </div>
        <div class="mint mt-2" id="pump-hot-launches"></div>
      </div>
      <div class="card">
        <div class="section-title">Market Scanner <span class="tip" tabindex="0" data-tip="Same live scanner feed as Overview. Full settings live on the Scanner tab."></span></div>
        <div id="scanner-status-signals" data-scanner-status class="mint text-xs mb-2">—</div>
        <div id="scanner-feed-signals" data-scanner-feed class="max-h-72 overflow-y-auto text-sm"></div>
      </div>
      <div class="card">
        <div class="section-title">Post-Run Dip · Smart Wallet Activity <span class="tip" tabindex="0" data-tip="Dip-phase confirmation: HQ buys, buybacks, Fib/support clusters, net SM flow. Soft conviction boost; optional hard-require in Conservative."></span></div>
        <div class="mint mb-2" id="prd-sm-status">—</div>
        <div class="overflow-x-auto max-h-72 overflow-y-auto">
          <table id="prd-sm-table">
            <thead>
              <tr>
                <th>Token</th>
                <th title="boost / skip / take">Outcome</th>
                <th title="Dip SM score 0–100">SM</th>
                <th title="High-quality wallet buys">HQ</th>
                <th title="Prior sellers / buyers buying back">Buyback</th>
                <th title="Cluster near Fib/support">@Level</th>
                <th title="Net smart-money flow">Flow</th>
                <th>Detail</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody><tr><td colspan="9" class="text-slate-500">No dip smart-wallet events yet — enable Post-Run Dip</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title">Recent Signals (risk / curve / sniper) <span class="tip" tabindex="0" data-tip="Why buys were taken or skipped: anti-rug, sniper score, curve stage, convergence."></span></div>
        <div id="activity-signals" class="max-h-80 overflow-y-auto text-sm"></div>
      </div>
      <div class="card">
        <div class="section-title">Dynamic Position Sizing <span class="tip" tabindex="0" data-tip="Calculated buy size for each evaluated signal from base × risk × conviction."></span></div>
        <div class="mint mb-2" id="sizing-status">—</div>
        <div class="overflow-x-auto max-h-72 overflow-y-auto">
          <table id="sizing-signals-table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Size SOL</th>
                <th>Conviction</th>
                <th>Risk</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody><tr><td colspan="7" class="text-slate-500">No sized signals yet</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title">Re-Entry Watch <span class="tip" tabindex="0" data-tip="Armed watches after TP (dip) or stop-loss (reclaim). Shows mint, stop reason, armed time, and status until confirm or expire."></span></div>
        <div class="overflow-x-auto">
          <table id="rebuy-table">
            <thead><tr><th>Token</th><th>Kind</th><th>Status</th><th title="Dip from peak or reclaim from trough">Move</th><th title="Confirming smart wallets">Wallets</th><th>Volume</th><th>Armed</th><th>Reason</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title">Recent Migrations <span class="tip" tabindex="0" data-tip="Tokens graduating off Pump.fun bonding curve onto Raydium/PumpSwap — often high-priority entries."></span></div>
        <div class="mint mb-1" id="mig-live-status-signals">Live feed is on Overview / Trades · open those tabs for WS status</div>
        <p class="text-sm text-slate-400">Migration events, re-buy watches, and open positions update live from the same APIs. Prefer the <button type="button" class="text-emerald-400 underline" onclick="showTab('trades', document.querySelector('[data-tab=trades]'))">Trades</button> tab on mobile.</p>
      </div>
      <div class="card">
        <div class="section-title">Trade Log Preview <span class="tip" tabindex="0" data-tip="Short feed of recent buys/sells. Full history is on the Logs tab."></span></div>
        <div id="logs" class="max-h-48 overflow-y-auto"></div>
      </div>
    </section>

    <!-- ========== TAB: Backtester ========== -->
    <section data-tab-panel="backtester" class="hidden space-y-4">
      <div class="card">
        <div class="section-title">Backtester <span class="tip" tabindex="0" data-tip="Historical candle replay with Live Sim decision + exit parity. Paper-only — no live orders."></span></div>
        <div class="mb-3 p-3 rounded-lg text-sm" style="background:#0f172a;border:1px solid #34d399;color:#94a3b8">
          <strong style="color:#e2e8f0">Parity with Live Sim — using your current Risk, Strict, modules, and Trade Profiles.</strong>
          <span class="mint block mt-1" id="bt-config-banner">Same entry gates, assignTradeProfile stamps, and exit ticks as paper / Live Sim. Historical prices only — fills will not match live 100%. Settings auto-track live (no separate BT store).</span>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl ctl-md"><span>Lookback hours <span class="tip" tabindex="0" data-tip="How far back to pull launch data (1–168 hours)."></span></span><input type="number" id="bt-hours" value="24" min="1" max="168" /></label>
          <label class="ctl ctl-md"><span>Max concurrent <span class="tip" tabindex="0" data-tip="Max open positions at once (same as Live Max Positions). Not a total-trade or per-day cap — after a position closes, new entries are allowed up to this many open for the rest of the lookback. Defaults from Risk Level. Selective rate limits (trades/hour, cooldown) still apply."></span></span><input type="number" id="bt-max" value="12" min="1" max="80" /></label>
          <label class="ctl ctl-md"><span>Start SOL <span class="tip" tabindex="0" data-tip="Starting paper bankroll for the simulation."></span></span><input type="number" id="bt-start-bal" value="10" min="0.5" max="100" step="0.5" /></label>
          <label class="ctl ctl-lg"><span>Strategy <span class="tip" tabindex="0" data-tip="Auto = bot defaults. Convergence = multi-wallet. Migration = grads only. Single = first wallet buy."></span></span>
            <select id="bt-strategy">
              <option value="auto">Auto</option>
              <option value="convergence">Convergence</option>
              <option value="migration">Migration plays</option>
              <option value="single">Single wallet</option>
            </select>
          </label>
          <label class="ctl ctl-lg"><span>Risk level <span class="tip" tabindex="0" data-tip="Current = your live saved Risk Level (parity default). Overrides apply for this run only then restore."></span></span>
            <select id="bt-risk-level" onchange="onBtRiskLevelChange()">
              <option value="current" selected>Use live Risk</option>
              <option value="on">Override → On</option>
              <option value="off">Override → Off</option>
            </select>
          </label>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl-check" title="Use live DexScreener/GMGN market data when available"><input type="checkbox" id="bt-live" checked /> Live data</label>
          <label class="ctl-check" title="Only simulate Pump.fun → DEX graduation plays"><input type="checkbox" id="bt-mig-only" /> Migration plays only</label>
          <label class="ctl-check" title="Only include Pump.fun / pump-tagged launches"><input type="checkbox" id="bt-pump-only" /> Pump.fun only</label>
          <label class="ctl-check" title="Allow dip re-entry after take-profit in the sim"><input type="checkbox" id="bt-rebuy" /> Re-buy enabled</label>
        </div>
        <details class="mb-3 p-3 rounded-lg" style="background:#0f172a;border:1px solid #334155" id="bt-advanced">
          <summary class="mint cursor-pointer text-sm" style="color:#e2e8f0">Advanced — Compare Risk · synthetic · multi-sim · filter overrides</summary>
          <p class="mint text-xs mt-2 mb-2">These break strict Live-Sim parity. Leave collapsed for default parity runs (synthetic OFF, 1 simulation, inherit live floors).</p>
          <div class="filters-row mb-2 mt-2">
            <label class="ctl ctl-md"><span>Simulations <span class="tip" tabindex="0" data-tip="Repeat the run N times (non-parity when &gt;1)."></span></span><input type="number" id="bt-sims" value="1" min="1" max="20" /></label>
            <label class="ctl ctl-md"><span>Min liquidity $ <span class="tip" tabindex="0" data-tip="0 = inherit live. Otherwise override for this run."></span></span><input type="number" id="bt-min-liq" value="0" min="0" step="1000" /></label>
            <label class="ctl ctl-md"><span>Min MC $ <span class="tip" tabindex="0" data-tip="0 = inherit live effective min MC. Otherwise override."></span></span><input type="number" id="bt-min-mc" value="0" min="0" step="1000" /></label>
            <label class="ctl ctl-md"><span>Min volume $ <span class="tip" tabindex="0" data-tip="0 = inherit live. Otherwise override."></span></span><input type="number" id="bt-min-vol" value="0" min="0" step="1000" /></label>
            <label class="ctl ctl-md"><span>Max risk score <span class="tip" tabindex="0" data-tip="0 = use live risk cap."></span></span><input type="number" id="bt-max-risk" value="0" min="0" max="100" step="5" /></label>
            <label class="ctl ctl-md"><span>Min conviction <span class="tip" tabindex="0" data-tip="0 = use live config."></span></span><input type="number" id="bt-min-conviction" value="0" min="0" max="90" step="5" /></label>
            <label class="ctl ctl-md"><span>Min wallet Q <span class="tip" tabindex="0" data-tip="0 = use live config."></span></span><input type="number" id="bt-min-wallet-q" value="0" min="0" max="90" step="5" /></label>
          </div>
          <div class="filters-row mb-1">
            <label class="ctl-check" title="Non-parity: invent price paths when live data is thin"><input type="checkbox" id="bt-synthetic" /> Allow synthetic</label>
            <label class="ctl-check" title="Non-parity: also run Risk On/Off on the same events"><input type="checkbox" id="bt-compare-risk" /> Compare Risk On / Off</label>
          </div>
        </details>
        <div id="bt-config-used" class="mint text-sm mb-2 hidden"></div>
        <div class="flex flex-wrap gap-2 items-center mb-2">
          <button class="btn btn-primary" id="bt-run-btn" onclick="runBacktest()" title="Run with Live Sim parity defaults">Run Backtest</button>
          <button class="btn btn-secondary" onclick="runBacktestMatchingLive()" title="Force current live Risk On/Off">Match live Risk</button>
          <button class="btn btn-secondary" onclick="loadLastBacktest()" title="Reload the most recent backtest from memory/disk">Load last</button>
          <button class="btn btn-secondary" onclick="exportBacktestCsv()" title="Download trade results as CSV"><span class="btn-label-short">CSV</span><span class="btn-label-full">Export CSV</span></button>
          <button class="btn btn-secondary" onclick="exportBacktestJson()" title="Download full metrics report as JSON"><span class="btn-label-short">JSON</span><span class="btn-label-full">Export JSON</span></button>
          <span class="mint" id="bt-status">—</span>
        </div>
        <div id="bt-progress-wrap" class="hidden mb-2" title="Simulation progress">
          <div class="flex justify-between text-xs text-slate-400 mb-1">
            <span id="bt-progress-label">Starting…</span>
            <span id="bt-progress-pct">0%</span>
          </div>
          <div style="height:8px;background:#1e293b;border-radius:4px;overflow:hidden">
            <div id="bt-progress-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#34d399,#10b981);transition:width .2s"></div>
          </div>
        </div>
        <div id="bt-result" class="mint mt-1"></div>
      </div>

      <div class="card">
        <div class="section-title">Performance Metrics <span class="tip" tabindex="0" data-tip="Key backtest KPIs after fees/slippage. Profit factor = gross wins ÷ gross losses. Sharpe = mean trade return ÷ std (not annualized). Max DD is equity-curve peak-to-trough. Check Compare Risk On/Off to add a risk-level breakdown."></span></div>
        <div class="grid grid-cols-1 lg:grid-cols-3 gap-2.5 sm:gap-3 mb-3">
          <div class="card !py-3 !bg-slate-900/50 score-card">
            <div class="stat-label">Performance Score <span class="tip" tabindex="0" data-tip="Score 0–100 from weighted Win Rate (30%), Profit Factor (25%), Max Drawdown inverted (20%), Avg Win/Loss (15%), sample-size confidence (10%). Tiny samples are penalized. A≥80, B≥65, C≥50, D≥35, else F."></span></div>
            <div class="score-grade score-tone-neutral" id="bt-score-grade">—</div>
            <div class="score-num score-tone-neutral" id="bt-score-num">—</div>
            <div class="mint mt-1 text-xs" id="bt-score-sub">After each run</div>
          </div>
          <div class="card !py-3 !bg-slate-900/50 lg:col-span-2">
            <div class="section-title !text-sm !mb-2">Live Sim vs This Backtest <span class="tip" tabindex="0" data-tip="Side-by-side KPIs vs your Live Simulation / paper ledger. Use Match live Strict for apples-to-apples."></span></div>
            <div class="overflow-x-auto">
              <table id="bt-perf-compare-table" class="text-xs">
                <thead><tr><th>Metric</th><th>Live Sim</th><th>Backtest</th><th>Edge</th></tr></thead>
                <tbody><tr><td colspan="4" class="text-slate-500">Run a backtest to compare</td></tr></tbody>
              </table>
            </div>
            <div class="mint text-xs mt-2" id="bt-perf-compare-winner">—</div>
          </div>
        </div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 mb-3">
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Win Rate <span class="tip" tabindex="0" data-tip="Scored win rate after fees/slip — excludes forced end-of-window (EOW) exits. Subtitle shows W/L on scored trades; EOW still count in Total Net PnL."></span></div><div class="stat" id="bt-stat-wr">—</div><div class="mint mt-1" id="bt-stat-wr-sub">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Profit Factor</div><div class="stat" id="bt-stat-pf">—</div><div class="mint mt-1" id="bt-stat-expect">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Total Net PnL</div><div class="stat" id="bt-stat-pnl">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Max Drawdown</div><div class="stat" id="bt-stat-maxdd">—</div><div class="mint mt-1" id="bt-stat-dd">avg trade DD —</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Sharpe Ratio</div><div class="stat" id="bt-stat-sharpe">—</div><div class="mint mt-1">trade returns</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Avg Win / Avg Loss</div><div class="stat text-base sm:text-xl" id="bt-stat-avg">—</div><div class="mint mt-1" id="bt-stat-avg-sol">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Number of Trades</div><div class="stat" id="bt-stat-trades">—</div><div class="mint mt-1" id="bt-stat-trades-sub">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Win / Loss Ratio</div><div class="stat" id="bt-stat-wlr">—</div><div class="mint mt-1" id="bt-stat-wl-counts">—</div></div>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 mb-3">
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Best / Worst</div><div class="stat text-base" id="bt-stat-bw">—</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Avg Hold</div><div class="stat text-base" id="bt-stat-hold">—</div><div class="mint mt-1" id="bt-stat-cost">RT cost —</div></div>
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Return</div><div class="stat" id="bt-stat-return">—</div><div class="mint mt-1" id="bt-stat-risk-used">risk —</div></div>
        </div>

        <div class="section-title !text-sm">Strategy Breakdown (migration vs normal)</div>
        <div class="overflow-x-auto mb-4">
          <table id="bt-strategy-table">
            <thead>
              <tr>
                <th>Strategy</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>W / L</th>
                <th>PnL SOL</th>
                <th>Profit Factor</th>
                <th>Avg Win %</th>
                <th>Avg Loss %</th>
                <th>Max DD</th>
                <th>Avg Hold</th>
              </tr>
            </thead>
            <tbody><tr><td colspan="10" class="text-slate-500">Run a backtest to see strategy breakdown</td></tr></tbody>
          </table>
        </div>

        <div class="section-title !text-sm">Trade Profile Breakdown <span class="tip" tabindex="0" data-tip="Same profile badges as Overview / Trades. Win rate excludes forced end-of-window MTM exits from strategy quality; profile table includes all closed trades."></span></div>
        <div class="overflow-x-auto mb-4">
          <table id="bt-profile-table">
            <thead>
              <tr>
                <th>Profile</th>
                <th>Trades</th>
                <th>Win Rate</th>
                <th>W / L</th>
                <th>PnL SOL</th>
                <th>Avg PnL %</th>
              </tr>
            </thead>
            <tbody><tr><td colspan="6" class="text-slate-500">Run a backtest to see profile breakdown</td></tr></tbody>
          </table>
        </div>

        <div id="bt-risk-compare" class="hidden">
          <div class="section-title !text-sm">Risk Level Breakdown <span class="tip" tabindex="0" data-tip="Enable Compare Risk On / Off on the run controls to populate this table and chart. Does not change live settings."></span></div>
          <p class="mint text-xs mb-2">Enable <strong>Compare Risk On / Off</strong> above, then re-run to compare the same events across risk presets.</p>
          <div class="overflow-x-auto mb-3">
            <table id="bt-risk-compare-table">
              <thead>
                <tr>
                  <th>Risk</th>
                  <th>Trades</th>
                  <th>Win Rate</th>
                  <th>PnL (SOL)</th>
                  <th>PF</th>
                  <th>Max DD</th>
                  <th>Sharpe</th>
                  <th>Avg Hold</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="chart-wrap mb-2" style="height:240px"><canvas id="bt-chart-risk"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-risk-empty">No risk comparison yet — check Compare Risk On / Off and run</div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Cumulative Equity Curve <span class="tip" tabindex="0" data-tip="Paper bankroll over the simulation as trades close (starts at Start SOL)."></span></div>
          <div class="chart-wrap" style="height:280px"><canvas id="bt-chart-pnl"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-empty">Run a backtest to see the equity curve</div>
        </div>
        <div class="card">
          <div class="section-title">Win / Loss Distribution <span class="tip" tabindex="0" data-tip="Trade counts and net SOL for wins vs losses."></span></div>
          <div class="chart-wrap" style="height:280px"><canvas id="bt-chart-wl"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-wl-empty">No distribution yet</div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Live Sim + Backtest Equity <span class="tip" tabindex="0" data-tip="Overlay cumulative PnL from Live Simulation ledger and last backtest (normalized to start at 0)."></span></div>
          <div class="chart-wrap" style="height:240px"><canvas id="bt-chart-overlay-equity"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-overlay-empty">Need Live Sim trades and a backtest run</div>
        </div>
        <div class="card">
          <div class="section-title">Performance Comparison Bars <span class="tip" tabindex="0" data-tip="Side-by-side Win Rate, Profit Factor, Max DD, Score — Live Sim vs last Backtest."></span></div>
          <div class="chart-wrap" style="height:240px"><canvas id="bt-chart-compare-bars"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-compare-empty">Run a backtest to compare</div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Strategy Comparison <span class="tip" tabindex="0" data-tip="PnL and win rate for migration vs normal entries."></span></div>
          <div class="chart-wrap" style="height:240px"><canvas id="bt-chart-strategy"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-strategy-empty">No strategy data yet</div>
        </div>
        <div class="card">
          <div class="section-title">PnL % Distribution <span class="tip" tabindex="0" data-tip="Histogram of realized trade PnL % after fees."></span></div>
          <div class="chart-wrap" style="height:240px"><canvas id="bt-chart-dist"></canvas></div>
          <div class="chart-empty mint" id="bt-chart-dist-empty">No histogram yet</div>
        </div>
      </div>

      <div class="card" id="bt-advisor-card">
        <div class="section-title">Smart Advisor <span class="tip" tabindex="0" data-tip="Clusters losing trades and skip reasons, proposes one-knob filter/toggle/profile changes, then shadow re-scores them on the same window. Never auto-applies to live."></span></div>
        <p class="mint text-xs mb-2" id="bt-advisor-disclaimer">Counterfactual on this backtest window only — not a live forward guarantee.</p>
        <div class="flex flex-wrap gap-2 items-center mb-2">
          <button class="btn btn-primary" id="bt-advisor-analyze-btn" onclick="analyzeBacktestAdvisor()" title="Analyze losers and score recommendations">Analyze losers</button>
          <button class="btn btn-secondary" id="bt-advisor-rerun-btn" onclick="rerunBacktestWithAdvisor()" title="Re-run last window with checked tips">Re-run with selected</button>
          <button class="btn btn-secondary" id="bt-advisor-apply-btn" onclick="applyAdvisorToLive()" title="Persist checked tips to live Settings">Apply selected to Settings</button>
          <span class="mint text-xs" id="bt-advisor-status">Run a backtest, then Analyze</span>
        </div>
        <div id="bt-advisor-evidence" class="mint text-xs mb-2 hidden"></div>
        <div id="bt-advisor-compare" class="mint text-xs mb-2 hidden"></div>
        <div class="overflow-x-auto max-h-80 overflow-y-auto">
          <table id="bt-advisor-table">
            <thead>
              <tr>
                <th></th>
                <th>Recommendation</th>
                <th>Evidence</th>
                <th>Δ WR</th>
                <th>Δ PF</th>
                <th>Δ PnL</th>
                <th>Keep?</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="7" class="text-slate-500">No advisor results yet</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card" id="bt-optimizer-card">
        <div class="section-title">Risk Recipe Optimizer <span class="tip" tabindex="0" data-tip="Searches bounded module/setting combos for Risk On on the same BT window. Ranks by constrained win rate."></span></div>
        <p class="mint text-xs mb-2" id="bt-optimizer-disclaimer">Same-window counterfactual — re-run on a second lookback before trusting. Apply writes per-risk overlays (Strict unchanged).</p>
        <div class="flex flex-wrap gap-2 items-center mb-2">
          <label class="mint text-xs flex items-center gap-1"><input type="checkbox" id="bt-opt-on" checked /> On</label>
          <label class="mint text-xs flex items-center gap-1">Max/risk <input type="number" id="bt-opt-max" value="16" min="4" max="24" step="1" style="width:3.5rem" /></label>
          <button class="btn btn-primary" id="bt-optimizer-run-btn" onclick="runRiskRecipeOptimizer()" title="Run optimizer on last backtest window">Run optimizer</button>
          <button class="btn btn-danger" id="bt-optimizer-stop-btn" onclick="stopRiskRecipeOptimizer()" title="Stop the running optimizer" disabled>Stop</button>
          <button class="btn btn-secondary" id="bt-optimizer-apply-btn" onclick="applyOptimizerWinners()" title="Apply selected (or winners) to synced risk recipes">Apply selected</button>
          <button class="btn btn-secondary" type="button" onclick="applyOptimizerWinners(true)" title="Apply each risk's top passer">Apply winners</button>
          <span class="mint text-xs" id="bt-optimizer-status">Run a backtest, then optimize</span>
        </div>
        <div id="bt-optimizer-progress" class="mint text-xs mb-2 hidden"></div>
        <div id="bt-optimizer-results" class="space-y-3"></div>
      </div>

      <div class="card">
        <div class="section-title">Trade Results (PnL SOL/USD · staged takes · wallet MC · delay) <span class="tip" tabindex="0" data-tip="PnL shows SOL and USD. Takes chips show whether partial / recovered initial happened before the remainder. Green/red row tint = win/loss. Hover Reason for full exit explanation."></span></div>
        <div class="overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table id="bt-results-table">
            <thead>
              <tr>
                <th title="Hover for contract address · click ticker to copy">Token</th>
                <th title="Assigned Trade Profile (same badges as Overview / Trades)">Profile</th>
                <th title="PnL %">PnL %</th>
                <th title="Profit/loss in SOL and USD">PnL SOL / USD</th>
                <th title="Staged profit takes: partial → recover initial → remainder">Takes</th>
                <th title="Estimated market cap when the smart wallet bought">Wallet MC</th>
                <th title="Estimated market cap when your copy filled (after delay)">Your MC</th>
                <th title="Market cap at exit (scaled from Dex snapshot at last price — path multiples are capped so h24 moons don't invent 50–100× rides)">Exit MC</th>
                <th title="Time from smart-wallet buy until your copy fill">Delay</th>
                <th title="Your hold time (copy fill → exit)">Hold</th>
                <th title="Max drawdown while open">Max DD</th>
                <th title="Estimated liquidity at your entry">Liq</th>
                <th title="Risk score">Risk</th>
                <th title="Smart wallets at entry">Wallets</th>
                <th title="Hover for full explanation + debug steps">Reason / Debug</th>
                <th title="Smart wallet entry date &amp; time">Wallet entry</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="16" class="text-slate-500">No backtest results yet</td></tr>
            </tbody>
          </table>
        </div>
        <details class="mt-3" id="bt-debug-panel">
          <summary class="mint cursor-pointer text-sm">Exit debug log (TP / SL / trail reasons)</summary>
          <pre id="bt-debug-log" class="mt-2 p-3 rounded text-xs overflow-x-auto max-h-64 overflow-y-auto" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;white-space:pre-wrap">Run a backtest to see step-by-step exit reasons (e.g. Sold at +45% due to trailing stop).</pre>
        </details>
      </div>
    </section>

    <!-- ========== TAB: Market Scanner ========== -->
    <section data-tab-panel="scanner" class="hidden space-y-4">
      <div class="card">
        <div class="section-title">Market Scanner <span class="tip" tabindex="0" data-tip="Autonomous TA / Pump.fun / Dex candidates — no wallet buy required. Same live feed as Overview and Signals."></span></div>
        <p class="text-sm text-slate-400 mb-2">
          <strong style="color:#5eead4">Hybrid</strong> = smart wallets + scanner both ON (shared mint).
          Scanner-only entries need a Fib/support/pattern setup when <em>Require TA setup</em> is on.
          Strategy module also lives under
          <button type="button" class="text-emerald-400 underline" onclick="showTab('settings', document.querySelector('[data-tab=settings]'))">Settings</button>
          → Market Scanner (TA).
        </p>
        <div id="scanner-status-tab" data-scanner-status class="mint text-xs mb-2">—</div>
        <div id="scanner-feed-tab" data-scanner-feed class="max-h-80 overflow-y-auto text-sm"></div>
      </div>

      <div class="card">
        <div class="section-title">Scanner Settings <span class="tip" tabindex="0" data-tip="Persisted in config.marketScanner. Enabling also toggles the ta_market_scanner strategy so the poll loop actually runs."></span></div>
        <p class="mint text-xs mb-3" style="color:#94a3b8;line-height:1.45">
          Universe: DexScreener + GMGN (+ Birdeye when keyed) recent launches, optional Jupiter Tokens API trending (Pump.fun), then TA enrich via Birdeye/GeckoTerminal OHLCV. Regime uses SOL Dex pairs.
        </p>
        <div class="toggle-row">
          <span>Enable Market Scanner <span class="tip" tabindex="0" data-tip="Turns scanner-only entries on. Soft preference + strategy gate (ta_market_scanner). Without this, the poll loop will not queue buys. Data: DexScreener / GMGN / Birdeye / Jupiter Tokens API."></span></span>
          <label class="switch"><input type="checkbox" id="ms-enabled" checked /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Require TA setup <span class="tip" tabindex="0" data-tip="Scanner-only entries must show Fib/support/pattern/indicator setup before queue. Improves entry quality; skips raw momentum without structure. TA from Birdeye/GeckoTerminal candles when Prefer real candles is on."></span></span>
          <label class="switch"><input type="checkbox" id="ms-require-ta" checked /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Prefer real candles <span class="tip" tabindex="0" data-tip="Prefer Birdeye/GeckoTerminal OHLCV over synthetic candle paths for ranking and TA. Synthetic paths get a rank penalty. Sources: Birdeye + GeckoTerminal."></span></span>
          <label class="switch"><input type="checkbox" id="ms-prefer-real" checked /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Pause scanner-only in risk-off <span class="tip" tabindex="0" data-tip="Skip scanner-only entries when SOL regime is risk_off (hybrid wallet+scanner still allowed). Regime from SOL Dex pairs (DexScreener)."></span></span>
          <label class="switch"><input type="checkbox" id="ms-pause-risk" checked /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Require RS for momentum <span class="tip" tabindex="0" data-tip="Momentum playbooks need token outperformance vs SOL (relative strength). Reduces weak beta-chasing entries. RS vs SOL Dex pairs."></span></span>
          <label class="switch"><input type="checkbox" id="ms-require-rs" checked /><span class="slider"></span></label>
        </div>
        <div class="filters-row mt-2">
          <label class="ctl ctl-md">
            <span>Poll interval (ms) <span class="tip" tabindex="0" data-tip="How often the scanner polls for new candidates (min 15000). Lower = fresher entries, more API load on DexScreener / GMGN / Jupiter."></span></span>
            <input type="number" id="ms-poll-ms" value="15000" min="15000" max="600000" step="1000" />
          </label>
          <label class="ctl ctl-sm">
            <span>Lookback (h) <span class="tip" tabindex="0" data-tip="Hours of recent launches to consider each poll from DexScreener / GMGN / Birdeye. Jupiter trending is separate (category windows)."></span></span>
            <input type="number" id="ms-lookback-h" value="6" min="0.5" max="48" step="0.5" />
          </label>
          <label class="ctl ctl-sm">
            <span>Max / poll <span class="tip" tabindex="0" data-tip="Max candidates handed to the buy pipeline per poll after ranking. Caps how many scanner entries can fire each cycle."></span></span>
            <input type="number" id="ms-max-cands" value="15" min="1" max="50" step="1" />
          </label>
          <label class="ctl ctl-md">
            <span>Cooldown (ms) <span class="tip" tabindex="0" data-tip="Min time before re-considering the same mint after a skip/take. Prevents re-entry spam on the same CA."></span></span>
            <input type="number" id="ms-cooldown-ms" value="2700000" min="60000" max="86400000" step="60000" />
          </label>
          <label class="ctl ctl-sm">
            <span>Min rank score <span class="tip" tabindex="0" data-tip="Minimum composite rank score (0–100) to queue a candidate. Higher = fewer, stronger entries from TA + volume + playbook scoring."></span></span>
            <input type="number" id="ms-min-rank" value="42" min="0" max="100" step="1" />
          </label>
          <label class="ctl ctl-sm">
            <span>Min pattern conf <span class="tip" tabindex="0" data-tip="Minimum chart-pattern confidence when TA setup is required. Patterns from real/synthetic candles (Birdeye/GeckoTerminal preferred)."></span></span>
            <input type="number" id="ms-min-pat-conf" value="55" min="0" max="100" step="1" />
          </label>
          <label class="ctl ctl-sm">
            <span>Synthetic penalty <span class="tip" tabindex="0" data-tip="Rank points deducted when candles are synthetic (not real OHLCV from Birdeye/GeckoTerminal). Encourages Prefer real candles."></span></span>
            <input type="number" id="ms-synth-pen" value="8" min="0" max="40" step="1" />
          </label>
          <label class="ctl ctl-sm">
            <span>Min confluence <span class="tip" tabindex="0" data-tip="Minimum playbook confluence (0–100) for scanner quality gate. Higher = stricter TA agreement before entry."></span></span>
            <input type="number" id="ms-min-confl" value="40" min="0" max="100" step="1" />
          </label>
        </div>

        <div class="mt-4 pt-3" style="border-top:1px solid #1e293b">
          <div class="section-title !mb-2 text-sm">Accuracy <span class="tip" tabindex="0" data-tip="Extra quality floors for scanner-only entries: MTF alignment, local liquidity, Jupiter organic score, and organic volume preference."></span></div>
          <div class="toggle-row">
            <span>Require MTF aligned <span class="tip" tabindex="0" data-tip="When on, scanner-only candidates must have multi-timeframe alignment (mtfAligned). Stricter entries; fewer false breakouts. From candle TA (Birdeye/GeckoTerminal)."></span></span>
            <label class="switch"><input type="checkbox" id="ms-require-mtf" /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <span>Prefer organic volume <span class="tip" tabindex="0" data-tip="When Jupiter organic buy/sell volumes are present, use them for volume floors instead of raw volume (reduces wash-trade noise). Source: Jupiter Tokens API."></span></span>
            <label class="switch"><input type="checkbox" id="ms-prefer-organic" checked /><span class="slider"></span></label>
          </div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md">
              <span>Min liquidity ($) <span class="tip" tabindex="0" data-tip="Scanner-local liquidity floor in USD. 0 = use global filters only. Applied with DexScreener / GMGN / Jupiter liquidity fields."></span></span>
              <input type="number" id="ms-min-liq" value="8000" min="0" max="5000000" step="500" />
            </label>
            <label class="ctl ctl-sm">
              <span>Min organic score <span class="tip" tabindex="0" data-tip="Scanner soft floor (Jupiter organicScore 0–100). 0 = disabled for scanner. Risk On also hard-rejects known scores below 30 as the bot's organic / pro-quality proxy. Terminal Pro Traders % is not available via Jupiter Tokens API — organicScore is the closest gate. Unknown score does not hard-skip early Pump."></span></span>
              <input type="number" id="ms-min-organic" value="0" min="0" max="100" step="1" />
            </label>
          </div>
        </div>

        <div class="mt-4 pt-3" style="border-top:1px solid #1e293b">
          <div class="section-title !mb-2 text-sm">Jupiter trending (Pump.fun) <span class="tip" tabindex="0" data-tip="Merges Jupiter Tokens API category lists into the scanner universe. Needs JUPITER_API_KEY from https://developers.jup.ag/portal. Filter to pump.fun mints and set per-window volume floors."></span></div>
          <div class="mint text-xs mb-2" id="ms-jupiter-status" style="color:#94a3b8">Jupiter: —</div>
          <div class="toggle-row">
            <span>Enable Jupiter trending <span class="tip" tabindex="0" data-tip="After Dex/GMGN launches, merge Jupiter top lists (dedupe by mint). Source: Jupiter Tokens API v2 category endpoint."></span></span>
            <label class="switch"><input type="checkbox" id="ms-jup-enabled" checked /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <span>Pump.fun only <span class="tip" tabindex="0" data-tip="Keep tokens whose mint ends with pump, or tags/launchpad/name hint Pump.fun. Focuses entries on that launchpad."></span></span>
            <label class="switch"><input type="checkbox" id="ms-jup-pump" checked /><span class="slider"></span></label>
          </div>
          <div class="toggle-row">
            <span>Merge intervals <span class="tip" tabindex="0" data-tip="Fetch 5m + 1h + 6h + 24h top lists and union by mint (fresher + broader universe). Off = 1h only. Source: Jupiter Tokens API."></span></span>
            <label class="switch"><input type="checkbox" id="ms-jup-merge" checked /><span class="slider"></span></label>
          </div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md">
              <span>Category <span class="tip" tabindex="0" data-tip="Jupiter list type: toptraded (volume), toptrending (price move), toporganicscore (organic activity). Source: Jupiter Tokens API."></span></span>
              <select id="ms-jup-category">
                <option value="toptraded">toptraded</option>
                <option value="toptrending">toptrending</option>
                <option value="toporganicscore">toporganicscore</option>
              </select>
            </label>
            <label class="ctl ctl-sm">
              <span>Limit <span class="tip" tabindex="0" data-tip="Tokens per Jupiter category/interval fetch (10–100). Higher = wider universe, more API usage."></span></span>
              <input type="number" id="ms-jup-limit" value="100" min="10" max="100" step="1" />
            </label>
            <label class="ctl ctl-sm">
              <span>Min vol 5m ($) <span class="tip" tabindex="0" data-tip="Minimum 5m volume USD to pass hard floor (0 = off). Uses Jupiter organic volume when Prefer organic volume is on."></span></span>
              <input type="number" id="ms-vol-m5" value="1000" min="0" max="10000000" step="100" />
            </label>
            <label class="ctl ctl-sm">
              <span>Min vol 1h ($) <span class="tip" tabindex="0" data-tip="Minimum 1h volume USD to pass hard floor (0 = off). DexScreener h1 or Jupiter stats1h."></span></span>
              <input type="number" id="ms-vol-h1" value="5000" min="0" max="50000000" step="500" />
            </label>
            <label class="ctl ctl-sm">
              <span>Min vol 6h ($) <span class="tip" tabindex="0" data-tip="Minimum 6h volume USD to pass hard floor (0 = off). Primarily Jupiter stats6h."></span></span>
              <input type="number" id="ms-vol-h6" value="10000" min="0" max="100000000" step="500" />
            </label>
            <label class="ctl ctl-sm">
              <span>Min vol 24h ($) <span class="tip" tabindex="0" data-tip="Minimum 24h volume USD to pass hard floor (0 = off). DexScreener h24 / Jupiter stats24h."></span></span>
              <input type="number" id="ms-vol-h24" value="15000" min="0" max="200000000" step="1000" />
            </label>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap gap-2 items-center">
          <button class="btn btn-primary" onclick="saveMarketScannerConfig()" title="Save scanner settings and restart the poll loop">Save Scanner Settings</button>
          <button class="btn btn-secondary" onclick="loadMarketScannerConfig()" title="Reload current values from the server">Reload</button>
          <span class="mint" id="ms-save-status">—</span>
        </div>
      </div>
    </section>

    <!-- ========== TAB: Zion ========== -->
    <section data-tab-panel="zion" class="zion-panel hidden space-y-4">
      <div class="card">
        <div class="section-title">KOL Token Scanner Feed</div>
        <div id="zion-scanner-feed" class="max-h-80 overflow-y-auto text-sm">—</div>
      </div>

      <div class="card">
        <div class="section-title">Trade Requests</div>
        <div id="zion-offers-feed" class="max-h-96 overflow-y-auto text-sm">—</div>
      </div>

      <div class="card">
        <div class="section-title">Open Trades <span class="tip" tabindex="0" data-tip="Positions entered via Zion / KOL Scan Place Trade. Overview and Trades tabs still show every open position."></span></div>
        <div id="zion-open-trades" class="max-h-72 overflow-y-auto text-sm">—</div>
      </div>

      <div class="card zion-hero-card">
        <div class="section-title">Zion <span class="tip" tabindex="0" data-tip="Personal KOL micro-bot. Isolated from copy trading and Market/Pump scanners. Never auto-buys — only creates trade offers for manual approval."></span></div>
        <p class="text-sm text-slate-400 mb-3" style="line-height:1.45">
          Primary signal: <strong class="zion-accent">KOL Token Scanner</strong> (Kolscan + GMGN universe, not your watch list).
          Tracked smart wallets are a <strong class="zion-accent">secondary boost</strong> only. Enabling Zion does not change Copy, Market Scanner, or strategy toggles.
        </p>
        <div class="toggle-row">
          <span>Enable Zion</span>
          <label class="switch"><input type="checkbox" id="zion-enabled" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>KOL Token Scanner</span>
          <label class="switch"><input type="checkbox" id="zion-scanner-enabled" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Auto-create offers from scanner</span>
          <label class="switch"><input type="checkbox" id="zion-auto-offer" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Tracked wallets as boost <span class="tip" tabindex="0" data-tip="Score boost only. Does NOT count toward Min KOL wallets — you still need that many real KOL wallets before an offer is created."></span></span>
          <label class="switch"><input type="checkbox" id="zion-tracked-boost" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Email on offer</span>
          <label class="switch"><input type="checkbox" id="zion-email-offer" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div class="toggle-row">
          <span>Email when placed</span>
          <label class="switch"><input type="checkbox" id="zion-email-placed" checked onchange="saveZionConfig()" /><span class="slider"></span></label>
        </div>
        <div id="zion-status" class="mint text-xs mb-2 mt-2">—</div>
      </div>

      <div class="card">
        <div class="section-title">Safeguards</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <label class="ctl ctl-sm"><span>Min KOL wallets <span class="tip" tabindex="0" data-tip="Hard floor: requires this many quality-passing KOL wallets. Tracked smart-wallet boost does not count toward this number."></span></span><input type="number" id="zion-min-kol" value="2" min="1" max="20" step="1" /></label>
          <label class="ctl ctl-sm"><span>Min wallet quality</span><input type="number" id="zion-min-quality" value="40" min="0" max="100" step="1" /></label>
          <label class="ctl ctl-sm"><span>Min MC ($)</span><input type="number" id="zion-min-mc" value="50000" min="0" step="1000" /></label>
          <label class="ctl ctl-sm"><span>Max MC ($)</span><input type="number" id="zion-max-mc" value="500000000" min="0" step="1000" /></label>
          <label class="ctl ctl-sm"><span>Offer TTL (min)</span><input type="number" id="zion-ttl" value="60" min="5" max="240" step="1" title="Pending offers expire after this many minutes (default 60). Popup auto-hides after 30s but the request stays Active until TTL." /></label>
          <label class="ctl ctl-sm"><span>Mint cooldown (min)</span><input type="number" id="zion-cooldown" value="120" min="5" max="1440" step="1" /></label>
          <label class="ctl ctl-sm"><span>Universe size</span><input type="number" id="zion-universe" value="60" min="20" max="100" step="1" /></label>
          <label class="ctl ctl-sm"><span>Poll interval (ms)</span><input type="number" id="zion-poll-ms" value="30000" min="30000" max="600000" step="1000" /></label>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Trade Presets</div>
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          <label class="ctl ctl-sm"><span>Size mode</span>
            <select id="zion-size-mode"><option value="sol">SOL</option><option value="usd">USD</option></select>
          </label>
          <label class="ctl ctl-sm"><span>SOL amount</span><input type="number" id="zion-sol" value="0.25" min="0.01" step="0.01" /></label>
          <label class="ctl ctl-sm"><span>USD amount</span><input type="number" id="zion-usd" value="50" min="1" step="1" /></label>
          <label class="ctl ctl-sm"><span>Take profit %</span><input type="number" id="zion-tp" value="80" min="5" step="1" /></label>
          <label class="ctl ctl-sm"><span>Stop loss %</span><input type="number" id="zion-sl" value="-25" max="-1" step="1" /></label>
          <label class="ctl ctl-sm"><span>Trail stop %</span><input type="number" id="zion-trail" value="18" min="1" step="1" /></label>
          <label class="ctl ctl-sm"><span>Trail activate %</span><input type="number" id="zion-trail-act" value="35" min="1" step="1" /></label>
        </div>
        <div class="toggle-row mt-2">
          <span>Apply exit presets on Place Trade</span>
          <label class="switch"><input type="checkbox" id="zion-use-exits" checked /><span class="slider"></span></label>
        </div>
        <div class="mt-3 flex flex-wrap gap-2 items-center">
          <button class="btn btn-primary" onclick="saveZionConfig()" title="Save Zion settings">Save Zion Settings</button>
          <button class="btn btn-secondary" onclick="loadZion()" title="Reload from server">Reload</button>
          <span class="mint" id="zion-save-status">—</span>
        </div>
      </div>
    </section>

    <div id="zion-offer-stack" class="zion-offer-stack" aria-live="polite" data-count="0"></div>

    <!-- ========== TAB: Micro Bots ========== -->
    <section data-tab-panel="microbots" class="strategies-panel hidden space-y-4">
      <div class="active-profile-banner tone-medium" data-active-profile id="active-profile-microbots" title="Tune who can fight, who wins, and which modules each micro-bot can use.">
        <div class="active-profile-main">
          <span class="active-profile-kicker">Micro Bots</span>
          <span class="risk-badge risk-badge-medium" data-risk-badge title="Risk Level">
            <svg class="status-ico risk-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
            <span class="risk-badge-label">On</span>
          </span>
          <span class="tip tip-below" tabindex="0" data-tip="Smart Bot Profiles ON = each trade profile is its own micro-bot lane. Multi-profile ON = lanes compete and the winner stamps the trade."></span>
        </div>
        <p class="active-profile-hint">Use this tab to tune micro-bot participation, lane fights, and profile-level modules without mixing it into the main settings page.</p>
      </div>

      <div class="card" style="background:#0b1220;border:1px solid #1e293b;padding:0.75rem">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-3 pb-3" style="border-bottom:1px solid #1e293b">
          <div style="min-width:0;flex:1">
            <div class="text-sm font-semibold text-slate-200">Smart Bot Profiles</div>
            <p class="text-xs text-slate-400 mb-0">ON = each profile is a micro-bot lane (own modules + Min/Max MC floors); lanes compete, one winner stamps the trade. Settings tab = global capability / kill switches. OFF = shared master modules for all profiles.</p>
          </div>
          <label class="ctl-check" title="Default ON — parallel micro-bot lanes with per-profile modules and MC floors">
            <input type="checkbox" id="smart-bot-profiles" onchange="toggleSmartBotProfiles(this.checked)" />
            <span>Smart Bot Profiles</span>
          </label>
        </div>
        <details class="card mt-3 mb-3 tp-tuning-details" id="tp-tuning-checklist-card" style="background:#0f172a;border:1px solid #334155;padding:0.75rem">
          <summary class="tp-tuning-summary">
            <span class="tp-tuning-summary-main">
              <span class="tp-tuning-chevron" aria-hidden="true">▶</span>
              <span class="text-sm font-semibold text-slate-200">Tuning checklist</span>
              <span class="mint text-xs font-normal">click to expand</span>
            </span>
            <button type="button" class="btn btn-secondary text-xs" onclick="event.preventDefault();event.stopPropagation();resetTuningChecklist()" title="Clear all checklist ticks">Reset checklist</button>
          </summary>
          <div class="tp-tuning-body mt-2">
            <p class="text-xs text-slate-400 mb-2">Follow this for accurate Smart Bot testing. Check items off as you go (saved in this browser).</p>
            <div class="text-xs font-semibold text-slate-300 mb-1">Before testing</div>
            <div class="tp-check-list" id="tp-check-before"></div>
            <div class="text-xs font-semibold text-slate-300 mb-1 mt-3">After ~15–20 closes per busy profile</div>
            <div class="tp-check-list" id="tp-check-after"></div>
            <div class="flex flex-wrap gap-2 mt-2">
              <button type="button" class="btn btn-secondary text-xs" onclick="document.getElementById('trade-profiles-overview-card')?.scrollIntoView({behavior:'smooth',block:'start'})">Jump to scoreboard</button>
            </div>
          </div>
        </details>
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div style="min-width:0;flex:1">
            <div class="text-sm font-semibold text-slate-200">Trade Profiles <span class="mint font-normal text-xs">(primary)</span></div>
            <p class="text-xs text-slate-400 mb-0">Each new trade is assigned to the best matching ON profile. You do <strong>not</strong> pick a scalp preset per trade — profiles + enabled modules decide.</p>
          </div>
          <label class="ctl-check" title="When off, all trades use Default (legacy single-stack behaviour)">
            <input type="checkbox" id="trade-profiles-master" onchange="toggleMultiProfiles(this.checked)" />
            <span>Multi-profile ON</span>
          </label>
        </div>
        <div class="profile-colour-legend mb-2" data-profile-legend role="region" aria-label="Profile colour legend">
          <div class="profile-colour-legend-head">
            <span class="profile-colour-legend-title">Profile colours</span>
            <span class="profile-colour-legend-hint">Matches trade badges</span>
          </div>
          <div class="profile-colour-legend-items" data-profile-legend-items></div>
        </div>
        <div class="tp-toggle-row" id="trade-profiles-toggles">Loading…</div>
        <div class="mt-3 pt-3 border-t border-slate-700/80" id="auto-scoring-panel">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div>
              <div class="text-sm font-semibold text-slate-200">Automatic Profile Scoring</div>
              <p class="text-xs text-slate-400 mb-0">Scores ON profiles, picks the best, can skip below min. OFF = simpler match rules only.</p>
            </div>
            <label class="ctl-check" title="Enable weighted auto-scoring">
              <input type="checkbox" id="auto-scoring-enabled" onchange="saveAutoScoringFromUi()" />
              <span>Auto-score ON</span>
            </label>
          </div>
          <div class="filters-row text-xs mb-2" id="auto-scoring-controls">
            <label class="ctl ctl-md"><span>Min score (0–100)</span><input type="number" id="auto-scoring-min" min="0" max="100" step="1" value="45" onchange="saveAutoScoringFromUi()" /></label>
            <label class="ctl-check" title="Skip the trade when the best ON profile scores below Min score">
              <input type="checkbox" id="auto-scoring-skip" checked onchange="saveAutoScoringFromUi()" />
              <span>Skip below min</span>
            </label>
            <label class="ctl ctl-lg" style="flex:1 1 12rem;min-width:10rem"><span>Force profile</span>
              <select id="auto-scoring-force" onchange="saveAutoScoringFromUi()">
                <option value="">— none (auto pick) —</option>
              </select>
            </label>
          </div>
          <details class="strat-adv-pack" style="border:none;background:transparent;margin:0">
            <summary style="padding:0.35rem 0">Scoring weights &amp; recent decisions</summary>
            <div class="strat-adv-body" style="border:none;padding:0.35rem 0 0">
              <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
                <div class="text-xs font-semibold text-slate-300">Weights <span class="mint font-normal" id="auto-scoring-weight-total">(100%)</span></div>
                <button type="button" class="btn btn-secondary text-xs" style="padding:0.15rem 0.45rem" onclick="resetAutoScoringWeights()">Reset defaults</button>
              </div>
              <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-xs" id="auto-scoring-weights">
                <label class="ctl"><span>Volume Behaviour</span><div class="flex items-center gap-1"><input type="number" data-w="volume" min="0" max="100" step="1" value="20" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Smart Wallet Activity</span><div class="flex items-center gap-1"><input type="number" data-w="smartMoney" min="0" max="100" step="1" value="16" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Token Age / Stage</span><div class="flex items-center gap-1"><input type="number" data-w="tokenAge" min="0" max="100" step="1" value="12" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Volatility / Speed</span><div class="flex items-center gap-1"><input type="number" data-w="volatility" min="0" max="100" step="1" value="11" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Support / Fib</span><div class="flex items-center gap-1"><input type="number" data-w="supportFib" min="0" max="100" step="1" value="10" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Chart Pattern Fit</span><div class="flex items-center gap-1"><input type="number" data-w="chartPatterns" min="0" max="100" step="1" value="10" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Migration Status</span><div class="flex items-center gap-1"><input type="number" data-w="migration" min="0" max="100" step="1" value="9" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Liquidity + Holders</span><div class="flex items-center gap-1"><input type="number" data-w="liquidityHolders" min="0" max="100" step="1" value="7" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
                <label class="ctl"><span>Market Session</span><div class="flex items-center gap-1"><input type="number" data-w="session" min="0" max="100" step="1" value="5" oninput="updateAutoWeightTotal()" onchange="saveAutoScoringFromUi()" /><span class="mint">%</span></div></label>
              </div>
              <div class="text-xs font-semibold text-slate-300 mb-1 mt-2">Recent profile decisions</div>
              <div class="tp-decisions" id="auto-scoring-decisions"><span class="mint">No decisions yet</span></div>
            </div>
          </details>
        </div>
      </div>

      <div class="card mt-4" id="trade-profiles-overview-card">
        <div class="section-title">Trade Profiles Overview</div>
        <p class="text-xs text-slate-400 mb-3">Quick reference for every profile — what it’s for, style, and recommended Risk Level. Active profiles are highlighted. Tap a row to jump to its controls.</p>
        <div class="tp-overview-wrap">
          <table class="tp-overview-table" id="trade-profiles-overview">
            <thead>
              <tr>
                <th scope="col">Profile</th>
                <th scope="col">Description</th>
                <th scope="col">Style</th>
                <th scope="col">Recommended Risk</th>
                <th scope="col">Win %</th>
                <th scope="col">Net PnL</th>
                <th scope="col">Avg hold</th>
                <th scope="col">Trades</th>
              </tr>
            </thead>
            <tbody id="trade-profiles-overview-body">
              <tr><td colspan="8" class="mint">Loading…</td></tr>
            </tbody>
          </table>
        </div>
        <div id="tp-scoreboard-detail" class="mt-3 text-xs text-slate-400"></div>
        <div id="tp-learning-panel" class="mt-3 hidden"></div>
        <div class="mt-3">
          <div class="text-xs font-semibold text-slate-300 mb-1">Lane fight log</div>
          <p class="text-xs text-slate-500 mb-1">Same live log as Overview — useful while tuning profiles.</p>
          <div class="tp-decisions lane-decisions" id="lane-decisions"><span class="mint">No lane fights yet</span></div>
        </div>
      </div>
    </section>

    <!-- ========== TAB: Settings ========== -->
    <section data-tab-panel="settings" class="strategies-panel hidden space-y-4">
      <div class="card strategy-risk-card">
        <div class="active-profile-banner tone-medium mb-3" data-active-profile id="active-profile-settings" title="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually.">
          <div class="active-profile-main">
            <span class="active-profile-kicker">Active Profile</span>
            <span class="risk-badge risk-badge-medium" data-risk-badge title="Risk Level">
              <svg class="status-ico risk-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
              <span class="risk-badge-label">On</span>
            </span>
            <span class="tip tip-below" tabindex="0" data-tip="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually one-by-one."></span>
          </div>
          <p class="active-profile-hint">Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually.</p>
        </div>
        <div class="section-title">Risk Level <span class="tip" tabindex="0" data-tip="On = lean baseline. Off = ops-only soak for high entry volume."></span></div>
        <div class="flex flex-wrap gap-2 items-center mb-2" id="risk-level-toggle">
          <button type="button" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" id="risk-lvl-on" onclick="setRiskLevel('on')" title="Lean baseline — hard floors + Copy/Scanner; enable quality modules manually">On</button>
          <button type="button" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" id="risk-lvl-off" onclick="setRiskLevel('off')" title="Ops-only soak: Copy + Scanner, no hard floors; max concurrent 40" style="border-color:#64748b">Off</button>
          <button type="button" class="btn btn-secondary text-xs sm:text-sm" id="btn-soak-preset" onclick="applySoakPreset()" title="Risk Off + clear skip counters — signal soak for 15–30+ opens">Soak preset</button>
          <span class="mint self-center" id="risk-level-label">—</span>
        </div>
        <div id="risk-level-warning" class="hidden text-amber-300 text-sm mb-2 font-medium"></div>
        <div class="mint text-sm" id="risk-level-summary">—</div>
        <div class="mint text-xs mt-1" id="risk-recipe-blurb">—</div>
        <div class="mint mt-2" id="risk-status">—</div>
        <details id="module-tune-card">
          <summary>
            <span class="module-tune-summary-main">
              <span class="module-tune-chevron" aria-hidden="true">▶</span>
              <span class="text-sm font-semibold text-slate-200">Module A/B tune order</span>
              <span class="mint text-xs font-normal">click to expand</span>
            </span>
            <span class="flex gap-2" onclick="event.preventDefault();event.stopPropagation()">
              <button type="button" class="btn btn-secondary text-xs" onclick="enableNextTuneModule()" title="Enable the next recommended module">Enable next</button>
              <button type="button" class="btn btn-secondary text-xs" onclick="resetSkipReasonCounts()" title="Clear skip-reason tallies">Clear skips</button>
            </span>
          </summary>
          <div class="module-tune-body">
            <p class="text-xs text-slate-400 mb-1" id="module-tune-hint">Enable one module at a time after soak baseline.</p>
            <ol class="text-xs text-slate-300 m-0 pl-4" id="module-tune-list" style="line-height:1.45"></ol>
          </div>
        </details>
      </div>

      <div class="card strategy-control-card">
        <div class="strategy-control-head">
          <div class="strategy-control-head-main">
            <div class="section-title">Settings Control Center</div>
            <div class="strategy-io-btns">
              <button type="button" class="btn btn-secondary text-xs" onclick="exportStrategyModulesJson()" title="Download module toggles, internal settings, and Trade Profiles (TP/SL/hold/Size ×/Max Trade/trail/fail-drop, Min MC/Max MC/holders/Top-10/Min Vol M5/conviction, Smart Bot) as JSON">Export JSON</button>
              <button type="button" class="btn btn-secondary text-xs" onclick="triggerStrategyModulesImport()" title="Import module toggles, settings, and Trade Profiles from a previously exported JSON">Import JSON</button>
              <button type="button" class="btn btn-secondary text-xs" onclick="resetStrategyModulesToDefaults()" title="Reset all strategy modules + Trade Profiles to the baked 2026-07-28 defaults (with trade profile overrides). Does not wipe wallets or paper.">Reset Strategy (Defaults)</button>
              <input type="file" id="strategy-import-file" accept=".json,application/json" style="display:none" onchange="importStrategyModulesJson(event)" />
            </div>
            <div class="strategy-io-status" id="strategy-io-status" aria-live="polite"></div>
            <p class="text-sm text-slate-400 mb-0">Pick Risk On/Off → enable modules as kill switches. Trade Profile import/export still lives here even though profile tuning moved to Micro Bots.</p>
          </div>
          <div class="strategy-control-head-meta">
            <div id="strategies-count" class="text-base font-semibold strategies-count-hot" tabindex="0" role="button" aria-expanded="false" title="Click to show which modules are ON">—</div>
            <div id="strategies-on-popover" class="strategies-on-popover hidden" role="tooltip"></div>
            <div id="strategies-profile" class="mint text-xs">Loading…</div>
          </div>
        </div>

        <div id="strategy-recipe-banner" class="strategy-recipe-banner is-synced" style="display:none">
          <div class="strategy-recipe-banner-copy">
            <span class="strategy-recipe-banner-title" id="strategy-recipe-banner-title">Synced to Risk</span>
            <span class="strategy-recipe-banner-detail" id="strategy-recipe-banner-text"></span>
          </div>
        </div>

        <div class="strat-setup-guide mt-3" id="strat-setup-guide">
          <div class="sg-step"><span class="sg-num">1</span><span><strong>Soak preset (Risk Off)</strong> — prove entries (15–30 opens). Watch Overview lane fight log + opens.</span></div>
          <div class="sg-step"><span class="sg-num">2</span><span><strong>Exits + size</strong> — small base size; concurrent scale-down; dead-market / trail firing.</span></div>
          <div class="sg-step"><span class="sg-num">3</span><span><strong>Risk On lean</strong> — then Enable next module one-by-one; keep only if entry rate stays healthy.</span></div>
        </div>

        <div class="strategy-control-actions">
          <button class="btn btn-secondary text-xs" onclick="applyStrategiesAction('enable_all')">Enable All modules</button>
          <button class="btn btn-secondary text-xs" onclick="applyStrategiesAction('disable_all')">Disable All modules</button>
        </div>

        <div id="strategies-warning" class="hidden mt-3 p-2 rounded-lg text-amber-200 text-xs" style="background:#422006;border:1px solid #92400e"></div>
      </div>
      <div id="strategies-grid" class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card"><span class="mint">Loading strategies…</span></div>
      </div>
      <div id="strategy-settings-stash" class="hidden" aria-hidden="true"></div>
    </section>

    <!-- ========== TAB: Config ========== -->
    <section data-tab-panel="config" class="config-panel hidden space-y-4">
      <div class="active-profile-banner tone-medium" data-active-profile id="active-profile-config" title="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually. Change Risk on the Settings tab.">
        <div class="active-profile-main">
          <span class="active-profile-kicker">Active Profile</span>
          <span class="risk-badge risk-badge-medium" data-risk-badge title="Risk Level">
            <svg class="status-ico risk-badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/></svg>
            <span class="risk-badge-label">On</span>
          </span>
          <span class="tip tip-below" tabindex="0" data-tip="Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually. Change Risk on the Settings tab."></span>
        </div>
        <p class="active-profile-hint">Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually. <button type="button" class="text-sky-400 underline underline-offset-2" onclick="showTab('settings')">Edit in Settings</button></p>
      </div>
      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Trade Settings <span class="tip" tabindex="0" data-tip="Default buy size and take-profit / stop-loss band applied to new positions."></span></div>
          <div class="form-grid grid grid-cols-1 sm:grid-cols-2 gap-3" id="trade-config">
            <div class="field">
              <label title="Base SOL per copy buy before risk/conviction scaling">Base Trade (SOL) — <span class="val" id="v-tradeAmountSol">0.14</span></label>
              <input type="range" id="tradeAmountSol" min="0.01" max="2" step="0.01" value="0.14" />
            </div>
            <div class="field">
              <label title="Hard ceiling on final entry size after all sizing math (risk/conviction/profile/concurrent). Clamps oversized buys — does not reject. Separate from Base Trade.">Max Allowed Trade (SOL) — <span class="val" id="v-maxAllowedTradeSol">1.5</span></label>
              <input type="range" id="maxAllowedTradeSol" min="0.05" max="10" step="0.05" value="1.5" />
            </div>
            <div class="field">
              <label title="Size floor multiplier at max risk score (lower = smaller on risky tokens)">Risk Multiplier — <span class="val" id="v-riskMultiplier">0.40</span></label>
              <input type="range" id="riskMultiplier" min="0.1" max="1" step="0.05" value="0.4" />
            </div>
            <div class="field">
              <label title="Size boost at max conviction (1 = none, 1.5 = +50%)">Conviction Multiplier — <span class="val" id="v-convictionMultiplier">1.45</span></label>
              <input type="range" id="convictionMultiplier" min="1" max="2.5" step="0.05" value="1.45" />
            </div>
            <div class="field">
              <label title="Minimum take-profit % before a sell is considered">Min Profit % — <span class="val" id="v-minProfitPercent">50</span></label>
              <input type="range" id="minProfitPercent" min="10" max="200" step="5" value="50" />
            </div>
            <div class="field">
              <label title="Hard ceiling — with profit strategy ON this caps full exit before trail; trail can still run the bag past this until stop hits">Max Profit % — <span class="val" id="v-maxProfitPercent">1000</span></label>
              <input type="range" id="maxProfitPercent" min="20" max="5000" step="5" value="1000" />
            </div>
            <div class="field">
              <label title="Hard stop-loss % from entry (negative)">Stop Loss % — <span class="val" id="v-stopLossPercent">-30</span></label>
              <input type="range" id="stopLossPercent" min="-80" max="-5" step="5" value="-30" />
            </div>
          </div>
          <p class="mint mt-2">Dynamic size = base × risk factor × conviction factor (± migration). High risk → closer to risk multiplier; high conviction → up to conviction multiplier.</p>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveTradeConfig()" title="Persist trade size and TP/SL settings">Save Trade</button></div>
        </div>

        <div class="card" data-strategy-source-card="true">
          <div class="section-title">Profit Strategy <span class="tip" tabindex="0" data-tip="Tiered exits: partial at a milestone → recover initial investment → leave a bag running with a trailing stop. Max Profit % above is the hard ceiling."></span></div>
          <p class="text-sm text-slate-400 mb-2">
            Flow: <strong>partial</strong> at milestone → <strong>recover initial</strong> → keep a <strong>bag</strong> → <strong>trail</strong> after high profit. Backtester uses the same rules.
          </p>
          <p class="mint mb-2">Master switch: Settings → Tiered Profit Taking.</p>
          <div class="toggle-row"><span title="On high-risk tokens: take profits earlier and use tighter stops/trails">Risk-based adjustment</span><label class="switch"><input type="checkbox" id="ps-risk-adjust" checked /><span class="slider"></span></label></div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md"><span>Partial at +% <span class="tip" tabindex="0" data-tip="First milestone. Example: 80 = sell a chunk when up 80%."></span></span><input type="number" id="ps-partial-at" value="80" min="10" max="500" step="5" /></label>
            <label class="ctl ctl-md"><span>Partial sell % <span class="tip" tabindex="0" data-tip="% of the *initial* position size to sell at the partial milestone (e.g. 50)."></span></span><input type="number" id="ps-partial-sell" value="50" min="5" max="90" step="5" /></label>
            <label class="ctl ctl-md"><span>Recover initial @+% <span class="tip" tabindex="0" data-tip="At this profit %, sell enough tokens to get your initial SOL back (e.g. 100% = 2x price → sell ~half)."></span></span><input type="number" id="ps-take-initial" value="100" min="20" max="500" step="5" /></label>
            <label class="ctl ctl-md"><span>Bag % <span class="tip" tabindex="0" data-tip="% of initial position left to run after recover/partials (e.g. 30)."></span></span><input type="number" id="ps-bag" value="30" min="5" max="80" step="5" /></label>
            <label class="ctl ctl-md"><span>Trail after +% <span class="tip" tabindex="0" data-tip="Arm trailing stop once unrealized profit hits this % (e.g. 150)."></span></span><input type="number" id="ps-trail-after" value="150" min="30" max="1000" step="10" /></label>
            <label class="ctl ctl-md"><span>Trail % <span class="tip" tabindex="0" data-tip="Trail distance from peak after armed (e.g. 25 = exit if price drops 25% from peak)."></span></span><input type="number" id="ps-trail-pct" value="25" min="5" max="80" step="1" /></label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveProfitStrategy()" title="Save profit strategy settings">Save Profit Strategy</button>
            <span class="mint ml-2" id="ps-status"></span>
          </div>
        </div>

        <div class="card">
          <div class="section-title">Paper / Live Simulation Prices <span class="tip" tabindex="0" data-tip="When on (or in Live Simulation mode), positions mark-to-market with live Dex/GMGN prices. Live Simulation forces this ON."></span></div>
          <p class="text-sm text-slate-400 mb-2">Use <strong>Live Sim</strong> in the header for full live-parity filters with virtual fills. Advanced historical sims are in <strong>Backtester</strong> (settings menu).</p>
          <div class="toggle-row"><span title="Update open paper / Live Sim positions using live price feeds">Live market marks</span><label class="switch"><input type="checkbox" id="paper-live-data" checked /><span class="slider"></span></label></div>
          <div class="flex flex-wrap gap-2 mt-2">
            <button class="btn btn-secondary" onclick="togglePaperLiveData()" title="Save the paper live-prices toggle">Save Live Price</button>
            <button class="btn btn-primary" onclick="showTab('backtester')">Open Backtester</button>
            <span class="mint" id="paper-live-status"></span>
          </div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card config-wide-card">
          <div class="section-title">Filters &amp; Anti-Rug <span class="tip" tabindex="0" data-tip="Gates that must pass before a buy: convergence, liquidity, holder risk, honeypot, snipers."></span></div>
          <div class="config-filter-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="field"><label title="Distinct smart wallets that must buy before you copy">Convergence — <span class="val" id="v-convergenceRequired">2</span></label><input type="range" id="convergenceRequired" min="1" max="5" step="1" value="2" /></div>
            <div class="field"><label title="Max open positions at once">Max Positions — <span class="val" id="v-maxConcurrentPositions">12</span></label><input type="range" id="maxConcurrentPositions" min="1" max="50" step="1" value="12" /></div>
            <div class="field"><label title="Stop new buys after this much daily realized loss">Daily Loss SOL — <span class="val" id="v-dailyLossLimitSol">2</span></label><input type="range" id="dailyLossLimitSol" min="0.5" max="20" step="0.5" value="2" /></div>
            <div class="field"><label title="Skip source wallets below this win rate (0 = off)">Min Win Rate % — <span class="val" id="v-minWinRate">0</span></label><input type="range" id="minWinRate" min="0" max="100" step="5" value="0" /></div>
            <div class="field"><label title="Minimum pool liquidity USD. Absolute floor $8,000 (recommended $8k–$15k). Floor is non-bypassable.">Min Liquidity USD — <span class="val" id="v-minLiquidity">10000</span></label><input type="range" id="minLiquidity" min="8000" max="100000" step="500" value="10000" /></div>
            <div class="field"><label title="Minimum entry / buy market-cap USD. Absolute floor $8,000 — non-bypassable across Risk On/Off. Rejects post-dump ghosts under ~$8k MC.">Min Market Cap USD — <span class="val" id="v-minMarketCapUsd">8000</span></label><input type="range" id="minMarketCapUsd" min="8000" max="100000" step="500" value="8000" /></div>
            <div class="field"><label title="Min % of supply held by the deployer (0 = no floor). Pair with Max Dev %.">Min Dev % — <span class="val" id="v-minDevHoldPct">0</span></label><input type="range" id="minDevHoldPct" min="0" max="80" step="1" value="0" /></div>
            <div class="field"><label title="Max % of supply held by the deployer (0 = off). Pair with Min Dev %.">Max Dev % — <span class="val" id="v-maxDevHoldPct">15</span></label><input type="range" id="maxDevHoldPct" min="0" max="80" step="1" value="15" /></div>
            <div class="field"><label title="Min % held by top 10 wallets (Jupiter Terminal Top 10 H. / audit.topHoldersPercentage preferred; on-chain excludes bonding-curve + LP vaults). Floor 5% when Risk On (default 8%). Pair with Max Top-10% for a valid band (e.g. 8–70%). Known values below min are blocked. Unknown top-10 after Jupiter + on-chain is soft-pass (score penalty only). Risk Off soak zeros both.">Min Top-10 % — <span class="val" id="v-minTop10HolderPct">8</span></label><input type="range" id="minTop10HolderPct" min="5" max="80" step="1" value="8" /></div>
            <div class="field"><label title="Max % held by top 10 wallets (pair with Min Top-10%). Default 70. 0 = off. Same key as maxHolderConcentration — not the single-wallet Max Top Holder %. Known values above max are blocked. Unknown top-10 after Jupiter + on-chain is soft-pass.">Max Top-10 % — <span class="val" id="v-maxHolderConcentration">70</span></label><input type="range" id="maxHolderConcentration" min="0" max="90" step="1" value="70" /></div>
            <div class="field"><label title="Min % held by a single wallet (0 = no floor). Independent of Top-10% band.">Min Top Holder % — <span class="val" id="v-minTopHolderPct">0</span></label><input type="range" id="minTopHolderPct" min="0" max="90" step="1" value="0" /></div>
            <div class="field"><label title="Max % held by a single wallet (independent of Top-10% band). 0 = off.">Max Top Holder % — <span class="val" id="v-maxTopHolderPct">70</span></label><input type="range" id="maxTopHolderPct" min="0" max="90" step="1" value="70" /></div>
            <div class="field"><label title="Hard max insider/rat (or extreme dev) hold %. Floor cap 50% — non-bypassable on Risk On when known. GMGN insider is fetched even when Sniper Filter is OFF. Unknown insider % soft-passes after fetch attempt (score penalty only); known ≥50% still hard-skips.">Max Insider % — <span class="val" id="v-maxInsiderPctDisplay">50</span></label><input type="range" id="maxInsiderPctDisplay" min="50" max="50" step="1" value="50" disabled title="Hard floor 50% — not adjustable (Risk On; known ≥50% hard-skips, unknown soft-pass)" /></div>
            <div class="field"><label title="Min composite rug/risk score (0 = no floor). Pair with Max Risk Score.">Min Risk Score — <span class="val" id="v-minRiskScore">0</span></label><input type="range" id="minRiskScore" min="0" max="100" step="5" value="0" /></div>
            <div class="field"><label title="Composite rug/risk score ceiling (0-100). 0 = off.">Max Risk Score — <span class="val" id="v-maxRiskScore">70</span></label><input type="range" id="maxRiskScore" min="0" max="100" step="5" value="70" /></div>
            <div class="field"><label title="Min estimated transfer tax / honeypot tax (0 = no floor). Pair with Max Tax %.">Min Tax % — <span class="val" id="v-minEstimatedTaxPct">0</span></label><input type="range" id="minEstimatedTaxPct" min="0" max="80" step="5" value="0" /></div>
            <div class="field"><label title="Estimated transfer tax / honeypot tax ceiling (0 = off). Pair with Min Tax %.">Max Tax % — <span class="val" id="v-maxEstimatedTaxPct">25</span></label><input type="range" id="maxEstimatedTaxPct" min="0" max="80" step="5" value="25" /></div>
            <div class="field"><label title="Source wallet must have been active this many days">Min Activity Days — <span class="val" id="v-minActivityDays">7</span></label><input type="range" id="minActivityDays" min="1" max="30" step="1" value="7" /></div>
            <div class="field"><label title="Source wallet min trades in last 30 days">Min Trades 30d — <span class="val" id="v-minTradesLast30d">5</span></label><input type="range" id="minTradesLast30d" min="0" max="50" step="1" value="5" /></div>
            <div class="field"><label title="Minimum 24h volume USD. Floor $15,000 for mature entries; early pump/migration may pass via recent (1h) volume + liquidity instead.">Min Vol 24h USD — <span class="val" id="v-minVolume24hUsd">25000</span></label><input type="range" id="minVolume24hUsd" min="15000" max="200000" step="500" value="25000" /></div>
            <div class="field"><label title="Min DexScreener ~1h volume USD (recent activity). Floor $1,500.">Min Recent Vol USD — <span class="val" id="v-minRecentVolumeUsd">2500</span></label><input type="range" id="minRecentVolumeUsd" min="1500" max="50000" step="100" value="2500" /></div>
            <div class="field"><label title="Min estimated recent buy-side volume USD. Floor $800.">Min Recent Buy Vol — <span class="val" id="v-minRecentBuyVolumeUsd">1500</span></label><input type="range" id="minRecentBuyVolumeUsd" min="800" max="25000" step="100" value="1500" /></div>
            <div class="field"><label title="Minimum holder count. Absolute floor 30 (non-bypassable); default 120. With Min Holders module ON, inactive wallets are soft-deprioritized for polling but stay enabled.">Min Holders — <span class="val" id="v-minHolders">120</span></label><input type="range" id="minHolders" min="30" max="500" step="5" value="120" /></div>
            <div class="field"><label title="Min DexScreener h1 buys+sells. Absolute floor 3; default 10.">Min Recent Activity — <span class="val" id="v-minRecentActivity">10</span></label><input type="range" id="minRecentActivity" min="3" max="100" step="1" value="10" /></div>
          </div>
          <div class="mt-2 space-y-0">
            <p class="mint mb-2">Master safety switches moved to Settings. Configure their thresholds here.</p>
            <div class="toggle-row"><span title="Only enter buys when the mint/contract ends with pump (Pump.fun convention). Hard floor — non-bypassable by soft-pass / early path.">Buy tokens only · pump.fun</span><label class="switch"><input type="checkbox" id="buyPumpFunOnly" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Probe sellability and transfer tax before buying">Honeypot / tax probe</span><label class="switch"><input type="checkbox" id="checkHoneypot" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Skip if the deployer sold recently (dump risk)">Skip recent dev sells</span><label class="switch"><input type="checkbox" id="skipIfDevRecentSells" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Require liquidity pool to look locked / burned">Require LP locked</span><label class="switch"><input type="checkbox" id="requireLiquidityLocked" /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Skip if mint authority is still active (can mint more)">Skip if mint authority</span><label class="switch"><input type="checkbox" id="skipIfMintAuthority" /><span class="slider"></span></label></div>
          </div>
          <div class="mt-2">
            <label class="ctl ctl-lg">
              <span>Sniper sensitivity <span class="tip" tabindex="0" data-tip="How strict the sniper/bundler thresholds are. High = more skips."></span></span>
              <select id="sniperSensitivity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
            </label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveFilterConfig()" title="Save filter and anti-rug settings">Save Filters</button></div>
        </div>

        <div class="card" data-strategy-source-card="true">
          <div class="section-title">Selective Trading <span class="tip" tabindex="0" data-tip="High-conviction gating: score signals, limit trade frequency, scale size by risk."></span></div>
          <p class="mint mb-2">Master switch: Settings → Multi-Factor Conviction Score.</p>
          <div class="toggle-row"><span title="Block single-wallet entries unless migration priority">Require convergence (normal)</span><label class="switch"><input type="checkbox" id="sel-require-convergence" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Allow 1-wallet buys on migration / near-migration">Single-wallet migration OK</span><label class="switch"><input type="checkbox" id="sel-allow-single-mig" checked /><span class="slider"></span></label></div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md"><span>Min conviction <span class="tip" tabindex="0" data-tip="Score 0–100 required to execute (after anti-rug)."></span></span><input type="number" id="sel-min-conviction" value="55" min="20" max="90" step="5" /></label>
            <label class="ctl ctl-sm"><span>Min wallets <span class="tip" tabindex="0" data-tip="Floor on distinct smart wallets."></span></span><input type="number" id="sel-min-wallets" value="2" min="1" max="5" step="1" /></label>
            <label class="ctl ctl-sm"><span>Max/hr <span class="tip" tabindex="0" data-tip="Max buys per rolling hour (0=off)."></span></span><input type="number" id="sel-max-per-hour" value="6" min="0" max="30" step="1" /></label>
            <label class="ctl ctl-md"><span>Cooldown sec <span class="tip" tabindex="0" data-tip="Min seconds between buys."></span></span><input type="number" id="sel-cooldown-sec" value="90" min="0" max="600" step="15" /></label>
            <label class="ctl ctl-sm"><span>Risk size @ <span class="tip" tabindex="0" data-tip="Risk score where size scaling starts."></span></span><input type="number" id="sel-risk-cutoff" value="35" min="0" max="80" step="5" /></label>
            <label class="ctl ctl-sm"><span>Min size × <span class="tip" tabindex="0" data-tip="Position size multiplier at max risk score."></span></span><input type="number" id="sel-min-size-mult" value="0.3" min="0.1" max="1" step="0.05" /></label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveSelectiveConfig()" title="Save selective trading settings">Save Selective</button></div>
        </div>

        <div class="card" data-strategy-source-card="true">
          <div class="section-title">Strategy <span class="tip" tabindex="0" data-tip="When and how aggressively to enter: convergence, migrations, early curve, auto-sell, re-buy."></span></div>
          <p class="mint mb-2">Entry master switches moved to Settings. Configure their detailed parameters here.</p>
          <div class="toggle-row"><span title="Only trade migration/graduation events">Migration Only</span><label class="switch"><input type="checkbox" id="enableMigrationOnly" /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Automatically sell on TP / SL / trailing rules">Auto-Sell</span><label class="switch"><input type="checkbox" id="enableAutoSell" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Also arm profit-dip watch after max-profit / full runner close (off by default)">Re-Entry After Max Profit</span><label class="switch"><input type="checkbox" id="reEntryAfterMaxProfitEnabled" /><span class="slider"></span></label></div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md"><span>Priority x <span class="tip" tabindex="0" data-tip="Size multiplier for priority migration entries."></span></span><input type="number" id="migrationSizeMultiplier" value="1.5" min="1" max="3" step="0.1" /></label>
            <label class="ctl ctl-md"><span>Slip bps <span class="tip" tabindex="0" data-tip="Extra slippage (basis points) allowed on migration buys."></span></span><input type="number" id="migrationSlippageBps" value="100" min="50" max="500" step="10" /></label>
            <label class="ctl ctl-md"><span>Near-mig % <span class="tip" tabindex="0" data-tip="Curve progress % that counts as near-migration."></span></span><input type="number" id="nearMigrationCurvePct" value="80" min="50" max="99" step="1" /></label>
            <label class="ctl ctl-md"><span>Early max % <span class="tip" tabindex="0" data-tip="Max curve % still considered early-curve."></span></span><input type="number" id="earlyCurveMaxPct" value="35" min="5" max="60" step="1" /></label>
            <label class="ctl ctl-md"><span>Min BE SM <span class="tip" tabindex="0" data-tip="Min Birdeye smart-money score for early-curve priority."></span></span><input type="number" id="minEarlyBirdeyeSmartMoneyScore" value="40" min="0" max="100" step="5" /></label>
            <label class="ctl ctl-sm"><span>Early wallets <span class="tip" tabindex="0" data-tip="Min distinct smart wallets on early curve to prioritize."></span></span><input type="number" id="earlyCurveMinSmartWallets" value="1" min="1" max="5" /></label>
            <label class="ctl ctl-md"><span>Rebuy profit % <span class="tip" tabindex="0" data-tip="Original trade must have hit this profit before re-buy watch arms."></span></span><input type="number" id="reBuyMinProfitPct" value="100" /></label>
            <label class="ctl ctl-md"><span>Dip % <span class="tip" tabindex="0" data-tip="Required pullback from peak before considering re-entry (negative)."></span></span><input type="number" id="reBuyDipPercent" value="-30" /></label>
            <label class="ctl ctl-sm"><span>Wallets <span class="tip" tabindex="0" data-tip="Confirming smart wallets needed to re-buy the dip."></span></span><input type="number" id="confirmationThreshold" value="4" /></label>
            <label class="ctl ctl-sm"><span>Vol +% <span class="tip" tabindex="0" data-tip="Extra volume increase % required to confirm the re-buy."></span></span><input type="number" id="reBuyVolumeIncreasePct" value="50" /></label>
            <label class="ctl ctl-sm"><span>Max/mint <span class="tip" tabindex="0" data-tip="Max successful re-entries per mint (cap + cooldown prevent loops)."></span></span><input type="number" id="reEntryMaxPerMint" value="2" min="1" max="8" /></label>
            <label class="ctl ctl-md"><span>Watch min <span class="tip" tabindex="0" data-tip="Minutes to keep watching after exit before the watch expires."></span></span><input type="number" id="reEntryWatchMinutes" value="90" min="5" max="360" /></label>
            <label class="ctl ctl-md"><span>Reclaim % <span class="tip" tabindex="0" data-tip="Min % bounce from post-stop trough (or sell/entry zone) before arming reclaim."></span></span><input type="number" id="reEntryMinReclaimPct" value="8" min="1" max="50" step="1" /></label>
            <label class="ctl ctl-md"><span>SL vol +% <span class="tip" tabindex="0" data-tip="Volume increase % to confirm stop re-entry (falls back to Vol +% if unset)."></span></span><input type="number" id="reEntryMinVolumeIncreasePct" value="50" min="5" max="200" /></label>
            <label class="ctl ctl-sm"><span>Size × <span class="tip" tabindex="0" data-tip="Position size multiplier for re-entries (usually smaller than first entry)."></span></span><input type="number" id="reEntrySizeMultiplier" value="0.65" min="0.15" max="1.5" step="0.05" /></label>
            <label class="ctl ctl-sm"><span>Cooldown m <span class="tip" tabindex="0" data-tip="Minutes between re-entry attempts on the same mint."></span></span><input type="number" id="reEntryCooldownMinutes" value="8" min="0" max="120" /></label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveStrategyConfig()" title="Save strategy toggles and parameters">Save Strategy</button></div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Risk Management <span class="tip" tabindex="0" data-tip="Position sizing, trailing stops, drawdown limits, and auto-pause when limits hit."></span></div>
          <div class="toggle-row"><span title="Enable the risk engine (limits, sizing, trails)">Risk engine</span><label class="switch"><input type="checkbox" id="riskEnabled" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Scale out in tiers as profit grows">Tiered selling</span><label class="switch"><input type="checkbox" id="tieredSellEnabled" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Pause the monitor when daily/weekly loss or DD limits trip">Auto-pause on limit</span><label class="switch"><input type="checkbox" id="autoPauseOnLimit" checked /><span class="slider"></span></label></div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-md"><span>Risk %/trade <span class="tip" tabindex="0" data-tip="% of bankroll risked per trade when risk-sizing is on."></span></span><input type="number" id="riskPercentPerTrade" value="1.5" step="0.1" /></label>
            <label class="ctl ctl-md"><span>Trail activate @+% <span class="tip" tabindex="0" data-tip="Profit % that arms the trailing stop."></span></span><input type="number" id="trailingActivationProfit" value="30" /></label>
            <label class="ctl ctl-sm"><span>Trail % <span class="tip" tabindex="0" data-tip="Trail distance from peak once armed."></span></span><input type="number" id="trailingStopPct" value="20" /></label>
            <label class="ctl ctl-sm"><span>Max DD % <span class="tip" tabindex="0" data-tip="Account max drawdown before risk halt."></span></span><input type="number" id="maxDrawdownPct" value="25" /></label>
            <label class="ctl ctl-md"><span>Weekly loss SOL <span class="tip" tabindex="0" data-tip="Weekly realized loss cap."></span></span><input type="number" id="weeklyLossLimitSol" value="5" step="0.1" /></label>
            <label class="ctl ctl-md"><span>Min trade SOL <span class="tip" tabindex="0" data-tip="Floor size after risk sizing."></span></span><input type="number" id="minTradeSol" value="0.02" step="0.01" /></label>
            <label class="ctl ctl-md"><span>Max trade SOL <span class="tip" tabindex="0" data-tip="Ceiling size after risk sizing."></span></span><input type="number" id="maxTradeSol" value="1" step="0.01" /></label>
            <label class="ctl ctl-md"><span>Normal risk % <span class="tip" tabindex="0" data-tip="Risk % for normal (non-migration) entries."></span></span><input type="number" id="normalRiskPct" value="1.5" step="0.1" /></label>
            <label class="ctl ctl-md"><span>Normal trail % <span class="tip" tabindex="0" data-tip="Trail % for normal entries."></span></span><input type="number" id="normalTrailPct" value="20" /></label>
            <label class="ctl ctl-md"><span>Mig risk % <span class="tip" tabindex="0" data-tip="Risk % for migration priority entries."></span></span><input type="number" id="migRiskPct" value="2" step="0.1" /></label>
            <label class="ctl ctl-md"><span>Mig trail % <span class="tip" tabindex="0" data-tip="Trail % for migration entries."></span></span><input type="number" id="migTrailPct" value="25" /></label>
          </div>
          <div class="mt-3 p-3 rounded-lg" style="background:#0f172a;border:1px solid #334155">
            <div class="text-sm font-semibold text-slate-200 mb-2">Dead market exit <span class="tip" tabindex="0" data-tip="Force-sell when DexScreener 1h volume stays below the USD threshold and/or there are no trades for N consecutive hours. Skips brand-new positions until min hold."></span></div>
            <p class="mint mb-2">Master switch: Settings → Dead Market Exit.</p>
            <div class="filters-row mt-2">
              <label class="ctl ctl-md"><span>Vol/hr $ &lt; <span class="tip" tabindex="0" data-tip="Rolling 1h USD volume below this counts as dead."></span></span><input type="number" id="deadVolumeUsdPerHour" value="50" min="0" step="10" /></label>
              <label class="ctl ctl-sm"><span>Hours <span class="tip" tabindex="0" data-tip="Consecutive hours of dead samples before force-sell."></span></span><input type="number" id="deadVolumeConsecutiveHours" value="3" min="1" max="48" step="1" /></label>
              <label class="ctl ctl-md"><span>Min hold min <span class="tip" tabindex="0" data-tip="Do not apply dead-volume exit until the position has been open this many minutes."></span></span><input type="number" id="deadVolumeMinHoldMinutes" value="30" min="0" max="1440" step="5" /></label>
            </div>
          </div>
          <div class="flex flex-wrap gap-2 mt-3">
            <button class="btn btn-primary" onclick="saveRiskConfig()" title="Save risk management settings">Save Risk</button>
            <button class="btn btn-warning" onclick="clearRiskHalt()" title="Clear a risk halt so trading can resume">Clear halt</button>
          </div>
        </div>

        <div class="card">
          <div class="section-title">MEV / RPC <span class="tip" tabindex="0" data-tip="Jito tips, sandwich protection, and Solana RPC health for live execution."></span></div>
          <div class="mint mb-2" id="mev-status">—</div>
          <p class="mint mb-2">Master switch: Settings → MEV Protection.</p>
          <div class="toggle-row"><span title="Send swaps via Jito bundles when possible">Jito bundles</span><label class="switch"><input type="checkbox" id="useJitoBundles" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Detect recent buy clustering that looks like sandwich setup">Sandwich protection</span><label class="switch"><input type="checkbox" id="sandwichProtection" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Cancel the trade if sandwich risk is high">Abort on sandwich risk</span><label class="switch"><input type="checkbox" id="abortOnSandwichRisk" checked /><span class="slider"></span></label></div>
          <div class="filters-row mt-2">
            <label class="ctl ctl-lg"><span>Tip lamports <span class="tip" tabindex="0" data-tip="Base Jito tip in lamports."></span></span><input type="number" id="jitoTipLamports" value="10000" /></label>
            <label class="ctl ctl-sm"><span>Tip x <span class="tip" tabindex="0" data-tip="Multiplier applied to the tip in competitive conditions."></span></span><input type="number" id="tipMultiplier" value="1.5" step="0.1" /></label>
            <label class="ctl ctl-sm"><span>Prio x <span class="tip" tabindex="0" data-tip="Priority fee multiplier."></span></span><input type="number" id="priorityFeeMultiplier" value="1.5" step="0.1" /></label>
            <label class="ctl ctl-sm"><span>Max buyers <span class="tip" tabindex="0" data-tip="Recent same-block buyers before sandwich abort."></span></span><input type="number" id="sandwichMaxRecentBuys" value="3" /></label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveMevConfig()" title="Save MEV / tip settings">Save MEV</button></div>
          <div class="mt-4 section-title">RPC Status <span class="tip" tabindex="0" data-tip="Dual-lane Solana RPC: Primary for trading/copy/migrate; Secondary for Zion/KOL. If a lane is down ≥30 seconds, traffic piggybacks on the other (or any healthy fallback), then returns to the preferred lane when it recovers."></span></div>
          <div id="rpc-lane-docs" class="text-xs text-slate-400 mb-3" style="line-height:1.45">
            <div class="mb-2"><strong style="color:#e2e8f0">Primary (RPC_URL)</strong> — Trade profile bots, copy + signal scanner, market scanner entry RPC, Pump.fun migrate scanner, open-trade on-chain needs.</div>
            <div class="mb-2"><strong style="color:#e2e8f0">Secondary (RPC_SECONDARY or first RPC_FALLBACKS)</strong> — Zion + Place Trade, KOL Token Scanner, Zion trade requests / open-trade on-chain bits, wallet on-chain activity refresh.</div>
            <div class="mb-2"><strong style="color:#e2e8f0">No Solana RPC</strong> — Email (Resend/SMTP), wallet discovery/search (GMGN/Kolscan HTTP), open-trade mark prices (DexScreener).</div>
            <div class="mint">Failover: preferred lane must stay unhealthy ≥30 seconds before piggybacking on the other paid RPC (or any healthy fallback). Recovers to the preferred lane when it is healthy again. Override with RPC_FAILOVER_DOWN_MS (ms). Set RPC_URL + a distinct RPC_SECONDARY (different URL — alias SECONDARY_RPC also accepted) so Zion KOL does not share CU with copy/signals.</div>
          </div>
          <div id="rpc-summary" class="mint mb-2">—</div>
          <div id="rpc-lane-status" class="mint text-xs mb-2">—</div>
          <div class="overflow-x-auto"><table id="rpc-table"><thead><tr><th>Endpoint</th><th>Lane</th><th>OK</th><th>Latency</th><th>Success</th><th>Active</th></tr></thead><tbody></tbody></table></div>
          <div class="mint mt-2" id="jito-status"></div>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Email Notifications <span class="tip" tabindex="0" data-tip="Alerts when equity is low, a buy is blocked for insufficient available SOL, a trade closes in profit, or Zion offers fire. Delivery uses RESEND_API_KEY (recommended on Render) or SMTP_*. Without a verified domain, Resend’s onboarding@resend.dev sender can ONLY email the address on your Resend account — verify a domain + set RESEND_FROM to email anyone else. Secrets stay in Render env."></span></div>
        <div class="mint text-xs mb-3" id="notify-delivery-hint">Set RESEND_API_KEY on Render (or SMTP_*) to deliver mail. Events still appear in Logs without it.</div>
        <div class="grid grid-2 gap-3">
          <label class="ctl"><span>Enabled</span><input type="checkbox" id="notify-enabled" checked /></label>
          <label class="ctl"><span>Email</span><input type="email" id="notify-email" value="isaacpascua87@gmail.com" placeholder="you@example.com" /></label>
          <label class="ctl"><span>Low equity threshold (SOL)</span><input type="number" id="notify-low-equity-sol" min="0.1" step="0.1" value="1" /></label>
          <label class="ctl"><span>Low equity alert</span><input type="checkbox" id="notify-low-equity" checked /></label>
          <label class="ctl"><span>Insufficient funds alert</span><input type="checkbox" id="notify-insufficient" checked /></label>
          <label class="ctl"><span>Profitable close alert</span><input type="checkbox" id="notify-profit-close" checked /></label>
        </div>
        <div class="mt-3 flex flex-wrap gap-2 items-center">
          <button type="button" class="btn btn-primary" onclick="saveNotificationsConfig()" title="Save notification preferences">Save Notifications</button>
          <button type="button" class="btn btn-secondary" onclick="testNotificationEmail()" title="Send a test email via SMTP">Send test email</button>
          <span class="mint text-xs" id="notify-status"></span>
        </div>
      </div>

      <div class="card">
        <div class="section-title">Persistence <span class="tip" tabindex="0" data-tip="Settings, wallets, paper balance, and backtest history are saved as JSON under the data directory (DATA_DIR). Survives code updates when a disk is mounted."></span></div>
        <div class="mint text-sm mb-3" id="persist-reset-status">Auto-saves on every config change, wallet import, paper top-up, and backtest run.</div>
        <div class="flex flex-wrap gap-2 items-center">
          <button type="button" class="btn btn-danger" onclick="resetToDefaults()" title="Delete saved JSON files and reload code defaults">Reset to Defaults</button>
          <span class="mint text-xs" id="persist-reset-msg"></span>
        </div>
      </div>
    </section>

    <!-- ========== TAB: Logs ========== -->
    <section data-tab-panel="logs" class="hidden space-y-4">
      <div class="card">
        <div class="filters-row mb-3">
          <div class="section-title !mb-0">Trade Logs <span class="tip" tabindex="0" data-tip="Chronological buy/sell/signal/info events from the trading engine."></span></div>
          <select id="log-filter-type" onchange="applyLogFilter()" title="Filter by event type">
            <option value="all">All types</option>
            <option value="buy">Buys</option>
            <option value="sell">Sells</option>
            <option value="error">Errors</option>
            <option value="info">Info</option>
            <option value="signal">Signals</option>
            <option value="risk">Risk / skips</option>
          </select>
          <input type="search" id="log-filter-q" placeholder="Filter text..." oninput="applyLogFilter()" title="Search log text" class="search-q" />
        </div>
        <div id="logs-full" class="max-h-[40vh] overflow-y-auto"></div>
      </div>

      <div class="card">
        <div class="filters-row mb-3">
          <div class="section-title !mb-0">System / Fetch Errors <span class="tip" tabindex="0" data-tip="API/RPC/fetch failures (GMGN, Birdeye, Jupiter, etc.) for debugging connectivity."></span></div>
          <select id="syslog-level" onchange="loadSystemLogs()" title="Filter by log level">
            <option value="all">All levels</option>
            <option value="error" selected>Errors</option>
            <option value="warn">Warnings</option>
            <option value="info">Info</option>
          </select>
          <select id="syslog-context" onchange="loadSystemLogs()" title="Filter by subsystem">
            <option value="">All contexts</option>
            <option value="GMGN">GMGN</option>
            <option value="RPC">RPC</option>
            <option value="Jupiter">Jupiter</option>
            <option value="Jito">Jito</option>
            <option value="DexScreener">DexScreener</option>
            <option value="RugCheck">RugCheck</option>
            <option value="Pump">Pump</option>
            <option value="MarketData">MarketData</option>
            <option value="Server">Server</option>
          </select>
          <input type="search" id="syslog-q" placeholder="Search…" oninput="debounceSysLogs()" title="Search system log messages" class="search-q" />
          <button type="button" class="btn btn-secondary" onclick="loadSystemLogs()" title="Reload system logs">Refresh</button>
          <button type="button" class="btn btn-warning" onclick="clearSystemLogs()" title="Clear in-memory system logs (disk log kept)">Clear</button>
          <span class="mint self-center" id="syslog-stats">—</span>
        </div>
        <div id="system-logs" class="max-h-[50vh] overflow-y-auto text-sm font-mono"></div>
      </div>
    </section>

    <div class="page-alerts" aria-live="polite">
      <div id="persist-banner" class="persist-banner" role="alert"></div>
      <div id="rpc-banner" class="persist-banner" role="alert" style="display:none"></div>
    </div>
  </div>

  <script>
    // --- Tabs ---
    function closeSettingsMenu() {
      const btn = document.getElementById('settings-btn');
      const menu = document.getElementById('settings-dropdown');
      if (menu) menu.classList.remove('open');
      if (btn) btn.setAttribute('aria-expanded', 'false');
    }

    function toggleSettingsMenu(event) {
      if (event) event.stopPropagation();
      const btn = document.getElementById('settings-btn');
      const menu = document.getElementById('settings-dropdown');
      if (!btn || !menu) return;
      const open = !menu.classList.contains('open');
      menu.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    document.addEventListener('click', (e) => {
      const wrap = document.getElementById('settings-menu-wrap');
      if (!wrap || wrap.contains(e.target)) return;
      closeSettingsMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSettingsMenu();
    });

    let _strategiesStatus = null;
    let _lastConfig = null;

    /** Canonical profile colours — keep in sync with TRADE_PROFILE_COLORS in tradeProfiles.ts */
    const PROFILE_VISUALS = {
      default: { name: 'Default', icon: '◆', color: '#94a3b8' },
      scalper: { name: 'Scalper', icon: '⚡', color: '#f97316' },
      dip_buyer: { name: 'Dip Buyer', icon: '↘', color: '#60a5fa' },
      trend_rider: { name: 'Trend Rider', icon: '▲', color: '#34d399' },
      migration_sniper: { name: 'Migration Sniper', icon: '🚀', color: '#c084fc' },
      migration: { name: 'Migration Sniper', icon: '🚀', color: '#c084fc' },
      high_win_rate: { name: 'High Win-Rate', icon: '◎', color: '#4ade80' },
      momentum_burst: { name: 'Momentum Burst', icon: '💥', color: '#22d3ee' },
      steady_compounder: { name: 'Steady Compounder', icon: '◇', color: '#8ba3c7' },
      reversal_scalper: { name: 'Reversal Scalper', icon: '↺', color: '#ff6b3d' },
      smart_money_mirror: { name: 'Smart Money Mirror', icon: '⧉', color: '#fbbf24' },
      zion: { name: 'Zion', icon: '◈', color: '#f2ae66' },
      legacy: { name: 'Legacy', icon: '·', color: '#64748b' },
      skipped: { name: 'Skipped', icon: '⊘', color: '#64748b' },
    };

    function profileColorFor(id) {
      const known = id && PROFILE_VISUALS[id];
      return (known && known.color) || '#64748b';
    }

    function resolveProfileVisual(p) {
      const stamped = p && (p.tradeProfileId || p.profileId);
      const candidate = stamped || (p && p.id) || 'legacy';
      const known = PROFILE_VISUALS[candidate] || null;
      const resolvedId = known ? candidate : (stamped || 'legacy');
      const vis = PROFILE_VISUALS[resolvedId] || PROFILE_VISUALS.legacy;
      const name = (p && p.tradeProfileName) || vis.name || 'Legacy';
      const icon = (p && p.tradeProfileIcon) || vis.icon || '·';
      // Prefer canonical palette so badges stay consistent even with old stamps
      const color = vis.color || '#64748b';
      return { id: resolvedId, name, icon, color };
    }

    /** Official legend order (matches Strategies overview). */
    const PROFILE_LEGEND_IDS = [
      'scalper',
      'dip_buyer',
      'migration_sniper',
      'high_win_rate',
      'momentum_burst',
      'steady_compounder',
      'reversal_scalper',
      'smart_money_mirror',
      'zion',
    ];

    function buildProfileColourLegendHtml() {
      return PROFILE_LEGEND_IDS.map(function (id) {
        const v = PROFILE_VISUALS[id];
        if (!v) return '';
        const style =
          'color:' + v.color + ';border-color:' + v.color + '99;background:' + v.color + '1f';
        return (
          '<span class="profile-colour-legend-item" style="' + style + '" title="' +
          escHtml(v.name) + '">' +
            '<span class="profile-colour-legend-swatch" style="background:' + v.color + '" aria-hidden="true"></span>' +
            '<span class="profile-colour-legend-icon" aria-hidden="true">' + escHtml(v.icon) + '</span>' +
            '<span class="profile-colour-legend-name">' + escHtml(v.name) + '</span>' +
          '</span>'
        );
      }).join('');
    }

    function paintProfileColourLegends() {
      const html = buildProfileColourLegendHtml();
      document.querySelectorAll('[data-profile-legend-items]').forEach(function (el) {
        el.innerHTML = html;
      });
    }
    paintProfileColourLegends();

    /** Globally ON for a tip row — prefer live Strategy Control Center toggles. */
    function profileTipModuleOn(m) {
      if (
        _strategiesStatus &&
        _strategiesStatus.toggles &&
        m &&
        m.key != null &&
        Object.prototype.hasOwnProperty.call(_strategiesStatus.toggles, m.key)
      ) {
        return _strategiesStatus.toggles[m.key] !== false;
      }
      return !m || m.enabled !== false;
    }

    /** Rich modules popover HTML for a trade profile (designed allowlist + global ON/OFF). */
    function fmtProfileModulesPopover(p) {
      const eff = p && p.effectiveModules;
      const smartOn =
        (window.__tradeProfilesStatus &&
          window.__tradeProfilesStatus.smartBotProfiles === true) ||
        (eff && eff.smartBotProfiles === true);
      const note = smartOn
        ? ''
        : '<div class="tp-mod-note">Smart Bot Profiles off — shared master modules apply</div>';
      let body = '';
      let activeCount = 0;
      let totalCount = 0;
      if (!eff || eff.mode === 'inherit_all' || (p && p.id === 'default')) {
        body =
          '<div class="tp-mod-inherit">All enabled master modules (inherit)</div>';
        // Same universe as Strategy Control Center (globally ON / total registry).
        if (_strategiesStatus) {
          activeCount = Number(_strategiesStatus.enabledCount) || 0;
          totalCount = Number(_strategiesStatus.totalCount) || 0;
        }
      } else {
        const mods = eff.modules || [];
        totalCount = mods.length;
        activeCount = mods.filter(profileTipModuleOn).length;
        if (!mods.length) {
          body = '<div class="tp-mod-empty">No modules in allowlist</div>';
        } else {
          body =
            '<ul class="tp-mod-list">' +
            mods
              .map(function (m) {
                const on = profileTipModuleOn(m);
                return (
                  '<li class="' +
                  (on ? 'is-on' : 'is-off') +
                  '">' +
                  '<span class="tp-mod-dot" aria-hidden="true"></span>' +
                  '<span class="tp-mod-name">' +
                  escHtml(m.name || m.key) +
                  '</span>' +
                  (on ? '' : '<span class="tp-mod-off">off</span>') +
                  '</li>'
                );
              })
              .join('') +
            '</ul>';
        }
      }
      const countBit =
        totalCount > 0 || (eff && eff.mode === 'allowlist')
          ? ' ' + activeCount + '/' + totalCount
          : '';
      return (
        '<span class="tp-mod-pop" role="tooltip">' +
        '<div class="tp-mod-title">Modules' + countBit + '</div>' +
        note +
        body +
        '</span>'
      );
    }

    const STRATEGY_SETTING_IDS = {
      wallet_convergence: ['sel-require-convergence', 'sel-min-wallets', 'convergenceRequired'],
      migration_priority: ['enableMigrationOnly', 'migrationSizeMultiplier', 'migrationSlippageBps'],
      near_migration_curve: ['nearMigrationCurvePct'],
      early_curve_smart_money: ['earlyCurveMaxPct', 'minEarlyBirdeyeSmartMoneyScore', 'earlyCurveMinSmartWallets'],
      rebuy_on_dip: ['reEntryAfterMaxProfitEnabled', 'reBuyMinProfitPct', 'reBuyDipPercent', 'confirmationThreshold', 'reBuyVolumeIncreasePct', 'reEntryMaxPerMint', 'reEntryWatchMinutes', 'reEntryMinReclaimPct', 'reEntryMinVolumeIncreasePct', 'reEntrySizeMultiplier', 'reEntryCooldownMinutes'],
      anti_rug_honeypot: ['minDevHoldPct', 'maxDevHoldPct', 'minTop10HolderPct', 'maxHolderConcentration', 'minTopHolderPct', 'maxTopHolderPct', 'minRiskScore', 'maxRiskScore', 'minEstimatedTaxPct', 'maxEstimatedTaxPct', 'checkHoneypot', 'skipIfDevRecentSells', 'requireLiquidityLocked', 'skipIfMintAuthority'],
      min_holders_activity: ['minHolders', 'minRecentActivity', 'minActivityDays', 'minTradesLast30d'],
      volume_liquidity_filters: ['minLiquidity', 'minVolume24hUsd', 'minRecentVolumeUsd', 'minRecentBuyVolumeUsd'],
      dead_market_exit: ['deadVolumeUsdPerHour', 'deadVolumeConsecutiveHours', 'deadVolumeMinHoldMinutes'],
      dynamic_position_sizing: ['riskMultiplier', 'convictionMultiplier', 'riskEnabled', 'riskPercentPerTrade', 'minTradeSol', 'maxTradeSol', 'normalRiskPct', 'migRiskPct'],
      tiered_profit_taking: ['enableAutoSell', 'tieredSellEnabled', 'minProfitPercent', 'maxProfitPercent', 'trailingActivationProfit', 'trailingStopPct', 'normalTrailPct', 'migTrailPct', 'ps-risk-adjust', 'ps-partial-at', 'ps-partial-sell', 'ps-take-initial', 'ps-bag', 'ps-trail-after', 'ps-trail-pct'],
      multi_factor_conviction: ['sel-min-conviction', 'sel-max-per-hour', 'sel-cooldown-sec', 'sel-risk-cutoff', 'sel-min-size-mult'],
      sniper_bundler_filters: ['sniperSensitivity'],
      social_sentiment_filter: ['socialSentimentSensitivity'],
      trending_narrative_boost: ['trendingNarrativeSensitivity', 'trendingNarrativeBoostPoints'],
      volume_spike_filter: [
        'volumeSpikeSensitivity',
        'volumeSpikeWindowMinutes',
        'volumeSpikeMultiplier',
        'volumeSpikeBuySidePct',
        'volumeSpikeMinUsd',
        'volumeSpikeBoostPoints',
        'volumeSpikeHardFilter',
      ],
      confirmation_layer: [
        'confirmationSensitivity',
        'confirmationVolumeWeight',
        'confirmationSentimentWeight',
        'confirmationNarrativeWeight',
        'confirmationBoostPoints',
        'confirmationHardFilter',
      ],
      market_session_filter: [
        'marketSessionAllowAsia',
        'marketSessionAllowEurope',
        'marketSessionAllowUs',
        'marketSessionAllowOverlap',
        'marketSessionAllowOffHours',
        'marketSessionPreferred',
        'marketSessionPreferBoostPoints',
      ],
      post_run_dip: [
        'prd-sensitivity',
        'prd-time-minutes',
        'prd-setup-watch',
        'prd-take-profit',
        'prd-stop-loss',
        'prd-min-run',
        'prd-max-run',
        'prd-min-dip',
        'prd-max-dip',
        'prd-min-age',
        'prd-max-age',
        'prd-near-pct',
        'prd-min-liq',
        'prd-min-holders',
        'prd-min-vol',
        'prd-boost',
        'prd-min-score',
        'prd-fibs',
        'prd-sessions',
        'prd-prefer-tech',
        'prd-require-tech',
        'prd-prefer-sm',
        'prd-strong-sm',
        'prd-require-sm',
        'prd-clear-vol',
        'prd-flex-vol',
        'prd-req-session',
        'prd-sm-sens',
        'prd-sm-boost',
        'prd-sm-hard-cons',
        'prd-zone-break',
        'prd-zone-vol',
        'prd-hard-require',
      ],
      technical_levels: [
        'tl-sensitivity',
        'tl-lookback-hours',
        'tl-lookback-min',
        'tl-lookback-max',
        'tl-near-pct',
        'tl-min-impulse',
        'tl-sr-lookback-hours',
        'tl-sr-lookback-min',
        'tl-sr-lookback-max',
        'tl-swing-strength',
        'tl-zone-width',
        'tl-min-touches',
        'tl-pivot',
        'tl-prefer-recent',
        'tl-prefer-recent-support',
        'tl-favour-volume',
        'tl-break-close',
        'tl-fib-zones',
        'tl-hard-filter',
        'tl-priority-fibs',
        'tl-secondary-fibs',
      ],
      chart_patterns: [
        'cp-sensitivity',
        'cp-mode',
        'cp-lookback',
        'cp-min-conf',
        'cp-breakout',
        'cp-pullback-near',
        'cp-min-pole',
        'cp-max-flag',
        'cp-min-struct-drop',
        'cp-max-struct-drop',
        'cp-vol-dry',
        'cp-vol-return',
        'cp-holder-drop',
        'cp-capitulation',
        'cp-bear-penalty',
        'cp-hard-filter',
        'cp-block-bearish',
        'cp-pat-ascending_triangle',
        'cp-pat-descending_triangle',
        'cp-pat-trendline_break',
        'cp-pat-holder_distribution',
        'cp-pat-capitulation',
      ],
      mev_protection: ['useJitoBundles', 'sandwichProtection', 'abortOnSandwichRisk', 'jitoTipLamports', 'tipMultiplier', 'priorityFeeMultiplier', 'sandwichMaxRecentBuys'],
    };

    function extraStrategySettingsHtml(key) {
      const n = (id, label, value, min, max, step) =>
        '<label class="ctl strat-field" data-strategy-control="' + id + '"><span>' + label + '</span><input type="number" id="' + id + '" value="' + value + '"' +
        (min != null ? ' min="' + min + '"' : '') + (max != null ? ' max="' + max + '"' : '') +
        (step != null ? ' step="' + step + '"' : '') + ' /></label>';
      const c = (id, label) =>
        '<label class="strat-check" data-strategy-control="' + id + '"><input type="checkbox" id="' + id + '" /><span>' + label + '</span></label>';
      const parts = {
        wallet_convergence:
          n('clusterMinWallets', 'Cluster wallets', 2, 1, 8, 1) +
          n('clusterWindowMinutes', 'Window min', 5, 1, 60, 1) +
          c('allowSingleWalletTopPerformerMigration', 'Single top-performer migration'),
        bonding_curve_health:
          c('requireHealthyCurve', 'Require healthy curve') +
          c('requireRecentCurveActivity', 'Require recent activity') +
          n('minCurveProgress', 'Min progress %', 0, 0, 99, 1) +
          n('maxCurveProgressForEntry', 'Max progress %', 98, 0, 100, 1),
        wallet_quality_scoring:
          c('enableWalletQualityGate', 'Quality gate') +
          c('enableWalletQualityAutoPrune', 'Auto-prune low quality') +
          n('minWalletQualityScore', 'Min quality', 55, 0, 100, 1) +
          n('walletQualityInactiveDays', 'Inactive days', 5, 1, 90, 1),
        time_based_entry:
          c('enableEntryTimingGate', 'Entry timing gate') +
          n('maxEntryAgeMinutes', 'Max age min', 15, 1, 180, 1) +
          n('preferEntryWithinMinutes', 'Prefer within min', 10, 1, 120, 1),
        sniper_bundler_filters:
          n('maxSniperCount', 'Max snipers', 8, 0, 100, 1) +
          n('maxBundlerPct', 'Max bundler %', 30, 0, 100, 1) +
          n('maxSniperScore', 'Max sniper score', 70, 0, 100, 1),
        social_sentiment_filter:
          '<p class="mint text-xs mb-2">Supporting filter — not a primary signal. Uses social/proxy heat (mention surge, pos/neg bias, smart-money/KOL activity) when data is available. If data is missing, trades are unchanged (fail-open).</p>' +
          '<label class="ctl strat-field" data-strategy-control="socialSentimentSensitivity"><span>Sensitivity</span>' +
            '<select id="socialSentimentSensitivity">' +
              '<option value="low">Low (gentle boost/skip)</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High (more reactive)</option>' +
            '</select></label>',
        trending_narrative_boost:
          '<p class="mint text-xs mb-2">Boosts tokens tied to currently hot narratives – used as confirmation, not a primary signal. Soft conviction bump only; ignored when no theme match / data unavailable.</p>' +
          '<label class="ctl strat-field" data-strategy-control="trendingNarrativeSensitivity"><span>Sensitivity</span>' +
            '<select id="trendingNarrativeSensitivity">' +
              '<option value="low">Low</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High</option>' +
            '</select></label>' +
          n('trendingNarrativeBoostPoints', 'Base conviction boost points', 6, 1, 20, 1),
        volume_spike_filter:
          '<p class="mint text-xs mb-2">Recommended Medium: 3× surge, 1–5m window, ≥65% buy-side, prefer acceleration, meaningful floor, Medium–High relative volume. Hard-blocks very weak spikes; boosts conviction when strong. Extra weight near migration. Fail-open if volume data missing.</p>' +
          '<label class="ctl strat-field" data-strategy-control="volumeSpikeSensitivity"><span>Sensitivity</span>' +
            '<select id="volumeSpikeSensitivity">' +
              '<option value="low">Low (prefer accel)</option>' +
              '<option value="medium" selected>Medium (prefer accel)</option>' +
              '<option value="high">High (require accel)</option>' +
            '</select></label>' +
          n('volumeSpikeWindowMinutes', 'Time window (minutes, 1–5 recommended)', 3, 1, 15, 1) +
          n('volumeSpikeMultiplier', 'Volume surge multiplier', 3, 1.5, 8, 0.1) +
          n('volumeSpikeBuySidePct', 'Buy-side % threshold', 65, 50, 90, 1) +
          n('volumeSpikeMinUsd', 'Min volume floor USD', 2500, 0, 500000, 100) +
          n('volumeSpikeBoostPoints', 'Conviction boost points', 8, 1, 20, 1) +
          c('volumeSpikeHardFilter', 'Hard filter (block weak spikes)'),
        confirmation_layer:
          '<p class="mint text-xs mb-2">Combines Volume Spike, Social Sentiment, and Trending Narrative into Weak / Moderate / Strong / Very Strong. Soft boost when Strong+; optional hard filter when Weak. Missing sentiment or narrative never blocks (weights renormalize). Volume weight highest by default for Pump.fun.</p>' +
          '<label class="ctl strat-field" data-strategy-control="confirmationSensitivity"><span>Sensitivity</span>' +
            '<select id="confirmationSensitivity">' +
              '<option value="low">Low</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High</option>' +
            '</select></label>' +
          n('confirmationVolumeWeight', 'Volume weight', 50, 0, 100, 1) +
          n('confirmationSentimentWeight', 'Sentiment weight', 25, 0, 100, 1) +
          n('confirmationNarrativeWeight', 'Narrative weight', 25, 0, 100, 1) +
          n('confirmationBoostPoints', 'Strong confirmation boost points', 10, 1, 22, 1) +
          c('confirmationHardFilter', 'Hard filter when confirmation is Weak'),
        market_session_filter:
          '<p class="mint text-xs mb-2">UTC sessions: Asia 00–08, Europe 07–16, US 13–22 (overlaps tagged). Preferred sessions get a soft conviction boost. Off-hours blocked by default. Current session shown on Overview.</p>' +
          '<p class="text-xs mb-2" id="market-session-live" style="color:#7dd3fc">Current session: —</p>' +
          c('marketSessionAllowAsia', 'Allow Asia') +
          c('marketSessionAllowEurope', 'Allow Europe') +
          c('marketSessionAllowUs', 'Allow US') +
          c('marketSessionAllowOverlap', 'Allow overlaps') +
          c('marketSessionAllowOffHours', 'Allow off-hours') +
          '<label class="ctl strat-field" data-strategy-control="marketSessionPreferred"><span>Preferred (comma ids)</span>' +
            '<input type="text" id="marketSessionPreferred" value="us,europe_us" /></label>' +
          n('marketSessionPreferBoostPoints', 'Preferred session boost', 3, 0, 10, 1),
        post_run_dip:
          '<p class="mint text-xs mb-2">Profiles: <strong>Standard</strong> (balanced), <strong>Conservative Post-Run Dip</strong> (fewer, higher quality), <strong>Aggressive Post-Run Dip</strong> (more opportunities — run +60–100%, age to 36h, Fib 0.382/0.5/0.618 ±3.5%, liq ≥$6.5k, holders ≥40, flexible vol, SM optional, wider sessions). Fine-tune after apply.</p>' +
          '<div class="flex flex-wrap gap-2 mb-3">' +
            '<button type="button" class="btn btn-secondary text-xs" id="prd-apply-standard" onclick="applyPostRunDipProfile(\\'standard\\')">Standard (Recommended)</button>' +
            '<button type="button" class="btn btn-secondary text-xs" id="prd-apply-conservative" onclick="applyPostRunDipProfile(\\'conservative\\')" style="border-color:#0f766e">Conservative Post-Run Dip</button>' +
            '<button type="button" class="btn btn-secondary text-xs" id="prd-apply-aggressive" onclick="applyPostRunDipProfile(\\'aggressive\\')" style="border-color:#ea580c">Aggressive Post-Run Dip</button>' +
          '</div>' +
          '<p class="text-xs mb-2" id="prd-active-profile" style="color:#7dd3fc">Active profile: —</p>' +
          '<label class="ctl strat-field" data-strategy-control="prd-sensitivity"><span>Sensitivity</span>' +
            '<select id="prd-sensitivity">' +
              '<option value="low">Low</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High</option>' +
            '</select></label>' +
          n('prd-time-minutes', 'Max hold (minutes)', 90, 30, 240, 5) +
          n('prd-setup-watch', 'Setup watch (minutes)', 60, 15, 180, 5) +
          n('prd-take-profit', 'Take-profit %', 35, 15, 80, 1) +
          n('prd-stop-loss', 'Stop-loss % (invalidation)', -14, -30, -8, 1) +
          n('prd-min-run', 'Min run %', 80, 20, 500, 5) +
          n('prd-max-run', 'Max run % (soft)', 150, 50, 1000, 5) +
          n('prd-min-dip', 'Min dip from peak %', 25, 5, 80, 1) +
          n('prd-max-dip', 'Max dip from peak %', 65, 20, 90, 1) +
          n('prd-min-age', 'Min token age (hours)', 12, 1, 72, 1) +
          n('prd-max-age', 'Max token age (hours)', 24, 6, 120, 1) +
          n('prd-near-pct', 'Fib/S distance ±%', 2.5, 1.5, 8, 0.05) +
          n('prd-min-liq', 'Min liquidity USD', 10000, 0, 250000, 500) +
          n('prd-min-holders', 'Min holders', 60, 0, 5000, 1) +
          n('prd-min-vol', 'Min volume USD', 5000, 0, 500000, 500) +
          n('prd-boost', 'Conviction boost (base)', 12, 1, 20, 1) +
          n('prd-min-score', 'Min qualify score', 55, 40, 90, 1) +
          '<label class="ctl strat-field" data-strategy-control="prd-fibs"><span>Preferred Fibs</span>' +
            '<input type="text" id="prd-fibs" value="0.5,0.618" /></label>' +
          '<label class="ctl strat-field" data-strategy-control="prd-sessions"><span>Preferred sessions</span>' +
            '<input type="text" id="prd-sessions" value="us,europe_us" /></label>' +
          c('prd-prefer-tech', 'Prefer near Fib / support') +
          c('prd-require-tech', 'Require near Fib/support') +
          c('prd-prefer-sm', 'Prefer smart money on dip') +
          c('prd-strong-sm', 'Strongly prefer smart money (Conservative)') +
          c('prd-require-sm', 'Require smart money on dip') +
          c('prd-sm-hard-cons', 'Conservative: hard-require dip SM activity') +
          '<label class="ctl strat-field" data-strategy-control="prd-sm-sens"><span>Dip SM sensitivity</span>' +
            '<select id="prd-sm-sens">' +
              '<option value="low">Low (more flexible)</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High (stricter HQ / flow)</option>' +
            '</select></label>' +
          n('prd-sm-boost', 'Dip SM conviction boost (max)', 8, 0, 15, 1) +
          c('prd-clear-vol', 'Require clear volume dry-up then return') +
          c('prd-flex-vol', 'Flexible volume confirmation (Aggressive)') +
          c('prd-req-session', 'Require preferred session (peak US)') +
          c('prd-zone-break', 'Invalidate on Fib/S zone break') +
          c('prd-zone-vol', 'Require volume on zone-break exit') +
          c('prd-hard-require', 'Hard-require setup (block non-dips)'),
        technical_levels:
          '<p class="mint text-xs mb-2">Pump.fun defaults — Fib: 2–6h, primary 0.5/0.618 as ±2% zones, secondary 0.382/0.786, 50% min impulse, most recent strong pump. S&amp;R: 1–4h (max 6), medium swings, ≥2 touches, zone ±2%, prefer recent strong supports, volume reaction, break+close invalidation. Used by Post-Run Dip. Paper / Live Sim / Backtester. All configurable.</p>' +
          '<label class="ctl strat-field" data-strategy-control="tl-sensitivity"><span>Sensitivity</span>' +
            '<select id="tl-sensitivity">' +
              '<option value="low">Low (wider near band)</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High (tighter near band)</option>' +
            '</select></label>' +
          '<p class="text-xs text-slate-400 mt-2 mb-1">Fibonacci</p>' +
          n('tl-lookback-hours', 'Fib lookback hours', 4, 1, 24, 0.5) +
          n('tl-lookback-min', 'Fib lookback min (h)', 2, 0.5, 24, 0.5) +
          n('tl-lookback-max', 'Fib lookback max (h)', 6, 1, 48, 0.5) +
          n('tl-near-pct', 'Entry tolerance ±%', 2, 0.5, 12, 0.1) +
          n('tl-min-impulse', 'Min impulse move %', 50, 10, 500, 5) +
          '<label class="ctl strat-field" data-strategy-control="tl-priority-fibs"><span>Primary Fibs</span>' +
            '<input type="text" id="tl-priority-fibs" value="0.5,0.618" /></label>' +
          '<label class="ctl strat-field" data-strategy-control="tl-secondary-fibs"><span>Secondary Fibs</span>' +
            '<input type="text" id="tl-secondary-fibs" value="0.382,0.786" /></label>' +
          c('tl-prefer-recent', 'Prefer most recent strong pump') +
          c('tl-fib-zones', 'Treat Fib levels as zones (±entry tol.)') +
          '<p class="text-xs text-slate-400 mt-2 mb-1">Support &amp; Resistance</p>' +
          n('tl-sr-lookback-hours', 'S&amp;R lookback hours', 2, 0.5, 6, 0.5) +
          n('tl-sr-lookback-min', 'S&amp;R lookback min (h)', 1, 0.5, 6, 0.5) +
          n('tl-sr-lookback-max', 'S&amp;R lookback max (h)', 4, 1, 6, 0.5) +
          '<label class="ctl strat-field" data-strategy-control="tl-swing-strength"><span>Swing strength</span>' +
            '<select id="tl-swing-strength">' +
              '<option value="low">Low</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High</option>' +
            '</select></label>' +
          n('tl-zone-width', 'Zone width ±%', 2, 0.5, 8, 0.1) +
          n('tl-min-touches', 'Min touches (valid level)', 2, 1, 8, 1) +
          n('tl-pivot', 'Pivot window', 2, 1, 6, 1) +
          c('tl-prefer-recent-support', 'Prefer most recent strong supports') +
          c('tl-favour-volume', 'Favour volume / bounce reaction') +
          c('tl-break-close', 'Break + close invalidation') +
          c('tl-hard-filter', 'Hard filter (block if not near Fib/S)'),
        chart_patterns:
          '<p class="mint text-xs mb-2">Optional <strong>extra</strong> patterns (triangles, trendline break, holder distribution, capitulation). The top-5 Pump.fun patterns are separate strategy toggles: Volume Dry-up+Return, Falling Wedge, Structured Pullback, Bull Flag, Trend Continuation. Soft boost; configurable sensitivity. Paper / Live Sim / Backtester.</p>' +
          '<label class="ctl strat-field" data-strategy-control="cp-sensitivity"><span>Sensitivity (shared)</span>' +
            '<select id="cp-sensitivity">' +
              '<option value="low">Low (looser)</option>' +
              '<option value="medium" selected>Medium</option>' +
              '<option value="high">High (stricter)</option>' +
            '</select></label>' +
          '<label class="ctl strat-field" data-strategy-control="cp-mode"><span>Use as</span>' +
            '<select id="cp-mode">' +
              '<option value="confirm">Confirmation only</option>' +
              '<option value="entry">Entry signal only</option>' +
              '<option value="both" selected>Entry + confirmation</option>' +
            '</select></label>' +
          n('cp-lookback', 'Lookback bars', 64, 12, 240, 1) +
          n('cp-min-conf', 'Min confidence', 55, 30, 90, 1) +
          n('cp-breakout', 'Breakout %', 1.2, 0.3, 8, 0.1) +
          n('cp-pullback-near', 'Pullback near %', 3, 0.5, 12, 0.1) +
          n('cp-min-pole', 'Min pole / impulse %', 25, 10, 200, 1) +
          n('cp-max-flag', 'Max flag range %', 18, 4, 40, 1) +
          n('cp-min-struct-drop', 'Structured pullback min %', 8, 3, 40, 1) +
          n('cp-max-struct-drop', 'Structured pullback max %', 35, 10, 60, 1) +
          n('cp-vol-dry', 'Volume dry-up ratio', 0.55, 0.2, 0.9, 0.05) +
          n('cp-vol-return', 'Volume return ratio', 1.35, 1.05, 4, 0.05) +
          n('cp-holder-drop', 'Holder drop warn %', 8, 2, 40, 0.5) +
          n('cp-capitulation', 'Capitulation drop %', 28, 12, 70, 1) +
          n('cp-bear-penalty', 'Bearish conviction penalty', 6, 0, 20, 1) +
          c('cp-hard-filter', 'Hard filter (require bullish pattern)') +
          c('cp-block-bearish', 'Block on strong bearish pattern') +
          '<p class="text-xs text-slate-400 mt-2 mb-1">Extra patterns (this toggle)</p>' +
          c('cp-pat-ascending_triangle', 'Ascending Triangle Breakout') +
          c('cp-pat-descending_triangle', 'Descending Triangle (bearish warn)') +
          c('cp-pat-trendline_break', 'Trendline Break (S/R)') +
          c('cp-pat-holder_distribution', 'Holder Drop / Distribution') +
          c('cp-pat-capitulation', 'Big Sell-off / Capitulation'),
        pattern_volume_dryup_return:
          '<p class="mint text-xs mb-2">Top Pump.fun setup — volume dries then returns with price. Shared sensitivity under Chart Patterns (extras). <strong>Primary:</strong> Dip Buyer, High Win-Rate, Steady Compounder · <strong>Secondary:</strong> Trend Rider. HWR prefers cleaner, higher-volume versions.</p>',
        pattern_falling_wedge:
          '<p class="mint text-xs mb-2">Converging lower highs/lows then breakout. <strong>Primary:</strong> Dip Buyer, High Win-Rate, Reversal Scalper · <strong>Secondary:</strong> Smart Money Mirror. HWR: well-formed wedges on higher liquidity only.</p>',
        pattern_structured_pullback:
          '<p class="mint text-xs mb-2">Orderly pullback after a strong run. <strong>Primary:</strong> Dip Buyer, High Win-Rate, Trend Rider · <strong>Secondary:</strong> Steady Compounder. HWR prefers pullbacks on Fib or strong support.</p>',
        pattern_bull_flag:
          '<p class="mint text-xs mb-2">Pole + tight flag/pennant continuation. <strong>Primary:</strong> Momentum Burst, Trend Rider, Migration Sniper · <strong>Secondary:</strong> High Win-Rate (stronger / higher MC only).</p>',
        pattern_trend_continuation:
          '<p class="mint text-xs mb-2">Buy pullbacks in HH/HL uptrends. <strong>Primary:</strong> Trend Rider, Steady Compounder, Smart Money Mirror · <strong>Secondary:</strong> High Win-Rate (higher holders, volume, structure).</p>',
        early_entry_only:
          '<p class="mint text-xs mb-2">Tightens max entry age (≤8m) and prefer-within window. Stacks with Time-Based Entry.</p>',
        hard_quality_gate:
          '<p class="mint text-xs mb-2">Raises min wallet quality floor to ≥68 (stacks with Risk/Strict).</p>',
        elite_convergence:
          '<p class="mint text-xs mb-2">Requires multi-wallet clusters, blocks single-wallet entries, raises conviction/quality floors. (60%+ Win Rate Profile uses cluster ≥3 / quality ≥65 / conviction ≥75.)</p>',
        migration_sniper:
          '<p class="mint text-xs mb-2">Only <strong>fresh</strong> pump.fun → DEX graduations (≤2h / MC ≤$450K). Older PumpSwap trades go to Trend / Dip / High Win-Rate instead.</p>',
        profit_protected:
          '<p class="mint text-xs mb-2">Forces tiered profit + aggressive dead-market exit; raises quality/conviction floors.</p>',
        quick_scalper:
          '<p class="mint text-xs mb-2">Timed scalps with fixed TP / tight SL. Auto-closes when the timer ends if neither hit. Overrides some Strict filters for speed; Risk Level still stacks. Paper, Live Sim, and backtests honor the timer.</p>' +
          '<label class="ctl strat-field" data-strategy-control="qs-time-limit"><span>Scalp time limit</span>' +
            '<select id="qs-time-limit">' +
              '<option value="1">1 minute</option>' +
              '<option value="2" selected>2 minutes</option>' +
              '<option value="3">3 minutes</option>' +
            '</select></label>' +
          n('qs-take-profit', 'Take-profit %', 35, 5, 200, 1) +
          n('qs-stop-loss', 'Stop-loss % (negative)', -12, -80, -1, 1) +
          n('qs-min-volume', 'Min volume USD', 8000, 0, 500000, 100) +
          n('qs-min-buy-pressure', 'Min buy pressure USD', 500, 0, 100000, 50),
        micro_scalper:
          '<p class="mint text-xs mb-2">Ultra-fast volume/buy spikes. Ranges depend on suite variant (Std 60–90s · Agg 45–75s · Cons 70–100s).</p>' +
          n('ms-time-seconds', 'Time limit (seconds)', 75, 45, 100, 5) +
          n('ms-take-profit', 'Take-profit %', 18, 12, 28, 1) +
          n('ms-stop-loss', 'Stop-loss % (negative)', -8, -12, -5, 1) +
          n('ms-min-volume', 'Min volume USD', 12000, 0, 500000, 100) +
          n('ms-min-buy-pressure', 'Min buy pressure USD', 800, 0, 100000, 50),
        momentum_burst:
          '<p class="mint text-xs mb-2">Sudden buy momentum. Timer in seconds (variant-aware). Exits on TP/SL/timer/momentum fail.</p>' +
          n('mb-time-seconds', 'Time limit (seconds)', 180, 90, 240, 15) +
          n('mb-take-profit', 'Take-profit %', 32, 22, 50, 1) +
          n('mb-stop-loss', 'Stop-loss % (negative)', -12, -16, -8, 1) +
          n('mb-fail-drop', 'Momentum fail drop % from peak', 8, 2, 40, 1) +
          n('mb-min-volume', 'Min volume USD', 15000, 0, 500000, 100) +
          n('mb-min-buy-pressure', 'Min buy pressure USD', 1200, 0, 100000, 50),
        post_migration_scalp:
          '<p class="mint text-xs mb-2">Fresh migrations with meaningful volume only. Ranges depend on suite variant.</p>' +
          n('pms-time-seconds', 'Time limit (seconds)', 120, 60, 180, 10) +
          n('pms-take-profit', 'Take-profit %', 30, 20, 45, 1) +
          n('pms-stop-loss', 'Stop-loss % (negative)', -11, -15, -7, 1) +
          n('pms-min-volume', 'Min volume USD (meaningful)', 10000, 0, 500000, 100) +
          n('pms-min-buy-pressure', 'Min buy pressure USD', 600, 0, 100000, 50),
        reversal_scalp:
          '<p class="mint text-xs mb-2">Optional / selective wick snap-back. Ranges depend on suite variant.</p>' +
          n('rs-time-seconds', 'Time limit (seconds)', 90, 45, 150, 15) +
          n('rs-take-profit', 'Take-profit %', 22, 15, 32, 1) +
          n('rs-stop-loss', 'Stop-loss % (negative)', -9, -13, -6, 1) +
          n('rs-min-drop', 'Min drop from peak %', 32, 5, 90, 1) +
          n('rs-min-conviction', 'Min conviction (selective)', 52, 0, 100, 1) +
          n('rs-min-volume', 'Min volume USD', 8000, 0, 500000, 100) +
          n('rs-min-buy-pressure', 'Min buy pressure USD', 400, 0, 100000, 50),
        momentum_confirmation:
          c('requireMomentumConfirmation', 'Require momentum') +
          n('momentumLookbackMinutes', 'Lookback min', 15, 1, 120, 1) +
          n('momentumMinHoldPct', 'Min hold %', -5, -80, 100, 1),
        smart_money_flow_weighting:
          n('smartMoneyFlowWeight', 'Flow weight ×', 1.35, 0, 5, .05),
      };
      return parts[key] || '';
    }

    function stashStrategyControls() {
      const stash = document.getElementById('strategy-settings-stash');
      if (!stash) return;
      document.querySelectorAll('#strategies-grid [data-strategy-setting]').forEach(el => stash.appendChild(el));
    }

    const SETTINGS_MODULE_GROUPS = [
      {
        label: 'Global & Safety',
        hint: 'Core copy flow, anti-rug gates, liquidity/holder filters, and execution safety.',
        keys: [
          'smart_money_copy',
          'anti_rug_honeypot',
          'bonding_curve_health',
          'min_holders_activity',
          'volume_liquidity_filters',
          'sniper_bundler_filters',
          'mev_protection',
        ],
      },
      {
        label: 'Smart Wallet & Conviction',
        hint: 'Wallet clustering, wallet quality, conviction scoring, and copy-quality gates.',
        keys: [
          'wallet_convergence',
          'wallet_quality_scoring',
          'multi_factor_conviction',
          'hard_quality_gate',
          'elite_convergence',
          'smart_money_flow_weighting',
          'confirmation_layer',
        ],
      },
      {
        label: 'TA / Scanner / Patterns',
        hint: 'Market Scanner, technical levels, chart patterns, and momentum/volume confirmation.',
        keys: [
          'ta_market_scanner',
          'technical_levels',
          'chart_patterns',
          'pattern_volume_dryup_return',
          'pattern_falling_wedge',
          'pattern_structured_pullback',
          'pattern_bull_flag',
          'pattern_trend_continuation',
          'market_session_filter',
          'volume_spike_filter',
          'momentum_confirmation',
        ],
      },
      {
        label: 'Trade Management & Micro-Bot Engines',
        hint: 'Position handling, profit/risk management, migrations, timing, and the engine modules used by micro-bots.',
        keys: [
          'dynamic_position_sizing',
          'tiered_profit_taking',
          'dead_market_exit',
          'profit_protected',
          'migration_priority',
          'near_migration_curve',
          'early_curve_smart_money',
          'migration_sniper',
          'time_based_entry',
          'early_entry_only',
          'rebuy_on_dip',
          'post_run_dip',
          'quick_scalper',
          'micro_scalper',
          'momentum_burst',
          'post_migration_scalp',
          'reversal_scalp',
        ],
      },
      {
        label: 'Optional / Lower Impact',
        hint: 'Nice-to-have or more experimental modules that are easier to disable or remove later.',
        keys: [
          'social_sentiment_filter',
          'trending_narrative_boost',
        ],
      },
    ];

    function buildSettingsModuleGroups(registry) {
      const byKey = new Map((registry || []).map(function (s) {
        return [s.key, s];
      }));
      const used = new Set();
      const groups = [];
      SETTINGS_MODULE_GROUPS.forEach(function (spec) {
        const rows = spec.keys
          .map(function (key) { return byKey.get(key); })
          .filter(Boolean);
        rows.forEach(function (row) { used.add(row.key); });
        if (rows.length) {
          groups.push({
            label: spec.label,
            hint: spec.hint,
            rows: rows,
          });
        }
      });
      const leftovers = (registry || []).filter(function (s) {
        return !used.has(s.key);
      });
      if (leftovers.length) {
        groups.push({
          label: 'Optional / Lower Impact',
          hint: 'Additional or less-central modules that are safe to review separately.',
          rows: leftovers,
        });
      }
      return groups;
    }

    function attachStrategyControls(registry) {
      Object.entries(STRATEGY_SETTING_IDS).forEach(([key, ids]) => {
        const target = document.getElementById('strategy-controls-' + key);
        if (!target) return;
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (!el) return;
          // Keep checkbox/radio with their label text — never orphan the input alone.
          const wrapper =
            el.closest('.field, .ctl, .toggle-row, label.strat-check, label.ctl-check, label.strat-field') ||
            ((el.type === 'checkbox' || el.type === 'radio') ? el.closest('label') : null) ||
            el;
          if (wrapper.parentElement === target) return; // already in place
          wrapper.setAttribute('data-strategy-setting', key);
          wrapper.setAttribute('data-strategy-control', id);
          if (
            wrapper.classList.contains('toggle-row') ||
            wrapper.classList.contains('ctl-check') ||
            wrapper.classList.contains('strat-check') ||
            ((el.type === 'checkbox' || el.type === 'radio') && wrapper.tagName === 'LABEL')
          ) {
            wrapper.classList.add('strat-check');
          } else {
            wrapper.classList.add('strat-field');
            if (wrapper.classList.contains('field') || el.type === 'range') {
              wrapper.classList.add('strat-slider');
            }
          }
          target.appendChild(wrapper);
        });
      });
      if (_lastConfig) applyStrategyConfigValues(_lastConfig);
    }

    function applyStrategyConfigValues(cfg) {
      if (!cfg) return;
      const set = (id, value, checked) => {
        const el = document.getElementById(id);
        if (!el || value == null) return;
        if (checked) el.checked = value !== false;
        else {
          el.value = value;
          const lab = document.getElementById('v-' + id);
          if (lab) lab.textContent = value;
        }
      };
      const f = cfg.filters || {};
      const b = cfg.bondingCurve || {};
      [
        ['clusterMinWallets', f.clusterMinWallets], ['clusterWindowMinutes', f.clusterWindowMinutes],
        ['minWalletQualityScore', f.minWalletQualityScore], ['walletQualityInactiveDays', f.walletQualityInactiveDays],
        ['maxEntryAgeMinutes', f.maxEntryAgeMinutes], ['preferEntryWithinMinutes', f.preferEntryWithinMinutes],
        ['maxSniperCount', f.maxSniperCount], ['maxBundlerPct', f.maxBundlerPct], ['maxSniperScore', f.maxSniperScore],
        ['momentumLookbackMinutes', f.momentumLookbackMinutes], ['momentumMinHoldPct', f.momentumMinHoldPct],
        ['smartMoneyFlowWeight', f.smartMoneyFlowWeight], ['minCurveProgress', b.minCurveProgress],
        ['maxCurveProgressForEntry', b.maxCurveProgressForEntry],
      ].forEach(x => set(x[0], x[1], false));
      [
        ['allowSingleWalletTopPerformerMigration', f.allowSingleWalletTopPerformerMigration],
        ['enableWalletQualityGate', f.enableWalletQualityGate],
        ['enableWalletQualityAutoPrune', f.enableWalletQualityAutoPrune],
        ['enableEntryTimingGate', f.enableEntryTimingGate],
        ['requireMomentumConfirmation', f.requireMomentumConfirmation],
        ['requireHealthyCurve', b.requireHealthyCurve],
        ['requireRecentCurveActivity', b.requireRecentCurveActivity],
      ].forEach(x => set(x[0], x[1], true));
    }

    function strategyFrequencyClass(impact) {
      if (impact === 'much_fewer' || impact === 'fewer') return 'text-amber-300';
      if (impact === 'more' || impact === 'slightly_more') return 'text-emerald-300';
      return 'text-slate-400';
    }

    function renderStrategies(data) {
      _strategiesStatus = data;
      if (data.moduleTune) renderModuleTune(data.moduleTune);
      const count = document.getElementById('strategies-count');
      const profile = document.getElementById('strategies-profile');
      const restore = document.getElementById('strategies-restore');
      const warning = document.getElementById('strategies-warning');
      const grid = document.getElementById('strategies-grid');
      const preset = String(data.strategyProfile || 'custom');
      if (count) count.textContent = data.enabledCount + ' / ' + data.totalCount + ' ON';
      const pop = document.getElementById('strategies-on-popover');
      if (pop) {
        const onMods = (data.registry || []).filter(function (s) { return s.enabled; });
        if (!onMods.length) {
          pop.innerHTML = '<div class="sop-empty">No modules ON</div>';
        } else {
          pop.innerHTML =
            '<div class="sop-title">' + onMods.length + ' module' + (onMods.length === 1 ? '' : 's') + ' ON</div>' +
            '<ul class="sop-list">' +
            onMods.map(function (s) {
              const badge = s.badge || s.source || '';
              return '<li><span class="sop-name">' + String(s.name || s.key) + '</span>' +
                (badge ? '<span class="sop-badge">' + badge + '</span>' : '') + '</li>';
            }).join('') +
            '</ul>';
        }
      }
      if (profile) {
        const recipe = data.recipe || {};
        const modeLabel = recipe.mode === 'custom' ? 'Custom modules' : 'Synced to Risk';
        profile.textContent =
          modeLabel +
          ' · Risk ' + String(data.riskLevel || 'on').toUpperCase() +
          (data.strictMode ? ' · Strict ' + String(data.strictModeIntensity || 'medium') : '') +
          (recipe.enabledCore != null
            ? ' · ' + recipe.enabledCore + ' core · ' + recipe.enabledRisk + ' risk'
            : '');
      }
      const recipeBanner = document.getElementById('strategy-recipe-banner');
      const recipeBannerTitle = document.getElementById('strategy-recipe-banner-title');
      const recipeBannerText = document.getElementById('strategy-recipe-banner-text');
      if (recipeBanner && recipeBannerText) {
        const recipe = data.recipe || {};
        recipeBanner.style.display = 'flex';
        const riskLabel = String(data.riskLevel || 'on').toUpperCase();
        if (recipe.mode === 'custom') {
          recipeBanner.classList.add('is-custom');
          recipeBanner.classList.remove('is-synced');
          if (recipeBannerTitle) {
            recipeBannerTitle.textContent = 'Settings customized — not synced to Risk';
          }
          recipeBannerText.textContent =
            (recipe.divergedFromRecipe
              ? recipe.divergedFromRecipe + ' modules differ from recipe. '
              : '') +
            'Use Reset Strategy (Defaults) for a full code reset.';
        } else {
          recipeBanner.classList.add('is-synced');
          recipeBanner.classList.remove('is-custom');
          if (recipeBannerTitle) {
            recipeBannerTitle.textContent = 'Synced to Risk ' + riskLabel;
          }
          const detailBits = [];
          if (recipe.summary) detailBits.push(recipe.summary);
          if (recipe.enabledCore != null) {
            detailBits.push(recipe.enabledCore + ' core · ' + recipe.enabledRisk + ' risk-linked ON');
          }
          recipeBannerText.textContent = detailBits.join(' · ');
          recipeBannerText.style.display = detailBits.length ? '' : 'none';
        }
      }
      if (restore) restore.disabled = !data.canRestorePrevious; // Restore UI removed — keep harmless
      const suitePresets = ['scalper_suite', 'aggressive_scalper', 'conservative_scalper'];
      const shortTermPresets = suitePresets.concat(['quick_scalper','micro_scalper','momentum_burst','post_migration_scalp','reversal_scalp']);
      if (warning) {
        const activePreset = (data.presets || []).find(p => p.active);
        const warnText = data.highWinRatePresetActive
          ? (data.highWinRateWarning || activePreset && activePreset.description)
          : (activePreset && activePreset.description);
        warning.textContent = warnText ? ('⚠ ' + warnText) : '';
        warning.classList.toggle('hidden', !(data.highWinRatePresetActive || (preset !== 'custom' && warnText)));
        if (preset === 'high_win_rate' || data.highWinRatePresetActive) {
          warning.style.background = '#422006';
          warning.style.borderColor = '#92400e';
          warning.style.color = '#fde68a';
          warning.textContent = '⚠ ' + (data.highWinRateWarning || 'Fewer trades expected – prioritises high win rate');
          warning.classList.toggle('hidden', false);
        } else if (preset === 'win_rate_55_60') {
          warning.style.background = '#1c1917';
          warning.style.borderColor = '#a16207';
          warning.style.color = '#fde68a';
          warning.textContent = 'Active: ' + (data.winRate55_60Description || 'Balanced high-quality profile – more trades than 60%+ version');
          warning.classList.toggle('hidden', false);
        } else if (preset === 'balanced' || preset === 'aggressive') {
          warning.style.background = '#0f172a';
          warning.style.borderColor = '#334155';
          warning.style.color = '#cbd5e1';
          warning.textContent = activePreset ? ('Active: ' + activePreset.description) : '';
          warning.classList.toggle('hidden', !activePreset);
        } else if (preset === 'scalper_suite') {
          warning.style.background = '#042f2e';
          warning.style.borderColor = '#14b8a6';
          warning.style.color = '#99f6e4';
          warning.textContent = 'Active: ' + (data.scalperSuiteDescription || 'Scalper Suite (Standard)');
          warning.classList.toggle('hidden', false);
        } else if (preset === 'aggressive_scalper') {
          warning.style.background = '#431407';
          warning.style.borderColor = '#ea580c';
          warning.style.color = '#fdba74';
          warning.textContent = 'Active: ' + (data.aggressiveScalperDescription || 'Aggressive Scalper');
          warning.classList.toggle('hidden', false);
        } else if (preset === 'conservative_scalper') {
          warning.style.background = '#0c1a2e';
          warning.style.borderColor = '#0369a1';
          warning.style.color = '#7dd3fc';
          warning.textContent = 'Active: ' + (data.conservativeScalperDescription || 'Conservative Scalper');
          warning.classList.toggle('hidden', false);
        } else if (shortTermPresets.includes(preset)) {
          warning.style.background = '#0c1a1a';
          warning.style.borderColor = '#0f766e';
          warning.style.color = '#99f6e4';
          warning.textContent = activePreset
            ? ('Active: ' + activePreset.description)
            : '⚠ Timed scalp — TP / SL / timer / signal-fail exits';
          warning.classList.toggle('hidden', false);
        } else {
          warning.style.background = '#422006';
          warning.style.borderColor = '#92400e';
          warning.style.color = '#fde68a';
          if (!warnText) warning.classList.toggle('hidden', true);
        }
      }
      const btBanner = document.getElementById('bt-config-banner');
      if (btBanner) {
        const rl = String(data.riskLevel || 'on').toUpperCase();
        btBanner.textContent =
          'Live preset: ' + preset.replace(/_/g, ' ') +
          ' · Risk ' + rl +
          (data.strictMode ? ' · Strict ' + String(data.strictModeIntensity || 'medium') : '') +
          ' · Backtest / Live Sim inherit these gates (overrides below are run-only).';
      }
      if (!grid) return;
      stashStrategyControls();
      const registry = data.registry || [];
      grid.innerHTML = buildSettingsModuleGroups(registry).map(group => {
        const rows = group.rows || [];
        return '<div class="card strategy-group-card">' +
          '<div class="section-title">' + group.label + '</div>' +
          (group.hint
            ? '<p class="text-xs text-slate-400 mb-3">' + group.hint + '</p>'
            : '') +
          rows.map(s => {
            const safety = s.criticalSafety
              ? '<span class="text-xs text-amber-300 ml-2">safety</span>'
              : '';
            const badgeKey = s.badge || s.source || 'optional';
            const badgeLabel =
              badgeKey === 'core' ? 'Core' :
              badgeKey === 'risk' ? 'Risk' :
              badgeKey === 'custom' ? 'Custom' : 'Optional';
            const badge =
              '<span class="strat-src-badge strat-src-' + badgeKey + '" title="' +
              (badgeKey === 'core'
                ? 'Core default — recommended always on'
                : badgeKey === 'risk'
                  ? 'Driven by Risk Level recipe when synced'
                  : badgeKey === 'custom'
                    ? 'Differs from current Risk recipe'
                    : 'Optional / advanced — not set by Risk') +
              '">' + badgeLabel + '</span>';
            const hasSettings = (STRATEGY_SETTING_IDS[s.key] || []).length > 0 || !!extraStrategySettingsHtml(s.key);
            return '<div class="strategy-row border-t border-slate-700/70 first:border-t-0">' +
              '<div class="flex items-center justify-between gap-3">' +
                '<div class="font-medium text-slate-100">' + s.name + badge + safety + '</div>' +
                '<label class="switch"><input type="checkbox" ' + (s.enabled ? 'checked ' : '') +
                  'onchange="toggleStrategy(\\'' + s.key + '\\', this.checked)" /><span class="slider"></span></label>' +
              '</div>' +
              '<div class="text-sm text-slate-400 mt-1">' + s.description + '</div>' +
              '<div class="text-xs mt-1 ' + strategyFrequencyClass(s.frequencyWhenOn) + '">' + s.frequencyLabel + '</div>' +
              (hasSettings
                ? '<details class="strategy-settings">' +
                    '<summary>Settings' + (s.enabled ? '' : ' · enable strategy to edit') + '</summary>' +
                    '<fieldset ' + (s.enabled ? '' : 'disabled') + '>' +
                      '<div class="strat-fields" id="strategy-controls-' + s.key + '">' +
                        extraStrategySettingsHtml(s.key) +
                      '</div>' +
                      '<div class="mt-3"><button type="button" class="btn btn-primary" onclick="saveStrategySettings(\\'' + s.key + '\\')">Save settings</button></div>' +
                    '</fieldset>' +
                  '</details>'
                : '') +
            '</div>';
          }).join('') +
        '</div>';
      }).join('');
      attachStrategyControls(registry);
      const fillShort = (cfg, map) => {
        if (!cfg) return;
        Object.entries(map).forEach(([id, val]) => {
          const el = document.getElementById(id);
          if (el && val != null) el.value = val;
        });
      };
      fillShort(data.quickScalper, {
        'qs-time-limit': data.quickScalper?.timeLimitMinutes,
        'qs-take-profit': data.quickScalper?.takeProfitPct,
        'qs-stop-loss': data.quickScalper?.stopLossPct,
        'qs-min-volume': data.quickScalper?.minVolumeUsd,
        'qs-min-buy-pressure': data.quickScalper?.minBuyPressureUsd,
      });
      fillShort(data.microScalper, {
        'ms-time-seconds': data.microScalper?.timeLimitSeconds,
        'ms-take-profit': data.microScalper?.takeProfitPct,
        'ms-stop-loss': data.microScalper?.stopLossPct,
        'ms-min-volume': data.microScalper?.minVolumeUsd,
        'ms-min-buy-pressure': data.microScalper?.minBuyPressureUsd,
      });
      fillShort(data.momentumBurst, {
        'mb-time-seconds': data.momentumBurst?.timeLimitSeconds ??
          ((data.momentumBurst?.timeLimitMinutes || 3) * 60),
        'mb-take-profit': data.momentumBurst?.takeProfitPct,
        'mb-stop-loss': data.momentumBurst?.stopLossPct,
        'mb-fail-drop': data.momentumBurst?.momentumFailDropPct,
        'mb-min-volume': data.momentumBurst?.minVolumeUsd,
        'mb-min-buy-pressure': data.momentumBurst?.minBuyPressureUsd,
      });
      fillShort(data.postMigrationScalp, {
        'pms-time-seconds': data.postMigrationScalp?.timeLimitSeconds ??
          ((data.postMigrationScalp?.timeLimitMinutes || 2) * 60),
        'pms-take-profit': data.postMigrationScalp?.takeProfitPct,
        'pms-stop-loss': data.postMigrationScalp?.stopLossPct,
        'pms-min-volume': data.postMigrationScalp?.minVolumeUsd,
        'pms-min-buy-pressure': data.postMigrationScalp?.minBuyPressureUsd,
      });
      fillShort(data.reversalScalp, {
        'rs-time-seconds': data.reversalScalp?.timeLimitSeconds ??
          ((data.reversalScalp?.timeLimitMinutes || 1.5) * 60),
        'rs-take-profit': data.reversalScalp?.takeProfitPct,
        'rs-stop-loss': data.reversalScalp?.stopLossPct,
        'rs-min-drop': data.reversalScalp?.minDropFromPeakPct,
        'rs-min-conviction': data.reversalScalp?.minConvictionScore,
        'rs-min-volume': data.reversalScalp?.minVolumeUsd,
        'rs-min-buy-pressure': data.reversalScalp?.minBuyPressureUsd,
      });
      const prdSens = document.getElementById('prd-sensitivity');
      if (prdSens && data.postRunDip?.sensitivity) prdSens.value = data.postRunDip.sensitivity;
      fillShort(data.postRunDip, {
        'prd-time-minutes': data.postRunDip?.timeLimitMinutes,
        'prd-setup-watch': data.postRunDip?.setupWatchMinutes,
        'prd-take-profit': data.postRunDip?.takeProfitPct,
        'prd-stop-loss': data.postRunDip?.stopLossPct,
        'prd-min-run': data.postRunDip?.minRunPct,
        'prd-max-run': data.postRunDip?.maxRunPct,
        'prd-min-dip': data.postRunDip?.minDipFromPeakPct,
        'prd-max-dip': data.postRunDip?.maxDipFromPeakPct,
        'prd-min-age': data.postRunDip?.minTokenAgeHours,
        'prd-max-age': data.postRunDip?.maxTokenAgeHours,
        'prd-near-pct': data.postRunDip?.nearTechnicalPct,
        'prd-min-liq': data.postRunDip?.minLiquidityUsd,
        'prd-min-holders': data.postRunDip?.minHolders,
        'prd-min-vol': data.postRunDip?.minVolumeUsd,
        'prd-boost': data.postRunDip?.boostPoints,
        'prd-min-score': data.postRunDip?.minQualifyScore,
      });
      const prdSessions = document.getElementById('prd-sessions');
      if (prdSessions && data.postRunDip?.preferredSessions) {
        prdSessions.value = Array.isArray(data.postRunDip.preferredSessions)
          ? data.postRunDip.preferredSessions.join(',')
          : String(data.postRunDip.preferredSessions);
      }
      const prdFibs = document.getElementById('prd-fibs');
      if (prdFibs && data.postRunDip?.preferredFibLevels) {
        prdFibs.value = Array.isArray(data.postRunDip.preferredFibLevels)
          ? data.postRunDip.preferredFibLevels.join(',')
          : String(data.postRunDip.preferredFibLevels);
      }
      const prdProfileLabel = document.getElementById('prd-active-profile');
      if (prdProfileLabel) {
        const p = data.postRunDip?.profile;
        prdProfileLabel.textContent =
          'Active profile: ' +
          (p === 'conservative'
            ? 'Conservative Post-Run Dip'
            : p === 'aggressive'
              ? 'Aggressive Post-Run Dip'
              : 'Standard (Recommended)');
      }
      const prdStdBtn = document.getElementById('prd-apply-standard');
      const prdConBtn = document.getElementById('prd-apply-conservative');
      const prdAggBtn = document.getElementById('prd-apply-aggressive');
      if (prdStdBtn) {
        prdStdBtn.classList.toggle(
          'active',
          data.postRunDip?.profile !== 'conservative' &&
            data.postRunDip?.profile !== 'aggressive'
        );
      }
      if (prdConBtn) {
        prdConBtn.classList.toggle('active', data.postRunDip?.profile === 'conservative');
      }
      if (prdAggBtn) {
        prdAggBtn.classList.toggle('active', data.postRunDip?.profile === 'aggressive');
      }
      const prdPrefer = document.getElementById('prd-prefer-tech');
      if (prdPrefer) prdPrefer.checked = data.postRunDip?.preferNearTechnicals !== false;
      const prdReq = document.getElementById('prd-require-tech');
      if (prdReq) prdReq.checked = data.postRunDip?.requireNearTechnicals === true;
      const prdPreferSm = document.getElementById('prd-prefer-sm');
      if (prdPreferSm) prdPreferSm.checked = data.postRunDip?.preferSmartMoney !== false;
      const prdStrongSm = document.getElementById('prd-strong-sm');
      if (prdStrongSm) prdStrongSm.checked = data.postRunDip?.stronglyPreferSmartMoney === true;
      const prdSm = document.getElementById('prd-require-sm');
      if (prdSm) prdSm.checked = data.postRunDip?.requireSmartMoney === true;
      const prdSmHard = document.getElementById('prd-sm-hard-cons');
      if (prdSmHard) prdSmHard.checked = data.postRunDip?.hardRequireSmartMoneyInConservative === true;
      const prdSmSens = document.getElementById('prd-sm-sens');
      if (prdSmSens && data.postRunDip?.smartWalletDipSensitivity) {
        prdSmSens.value = data.postRunDip.smartWalletDipSensitivity;
      }
      const prdSmBoost = document.getElementById('prd-sm-boost');
      if (prdSmBoost && data.postRunDip?.smartWalletDipBoostPoints != null) {
        prdSmBoost.value = data.postRunDip.smartWalletDipBoostPoints;
      }
      const prdClearVol = document.getElementById('prd-clear-vol');
      if (prdClearVol) prdClearVol.checked = data.postRunDip?.requireClearVolumeDryUp === true;
      const prdFlexVol = document.getElementById('prd-flex-vol');
      if (prdFlexVol) prdFlexVol.checked = data.postRunDip?.flexibleVolumeConfirmation === true;
      const prdReqSession = document.getElementById('prd-req-session');
      if (prdReqSession) prdReqSession.checked = data.postRunDip?.requirePreferredSession === true;
      const prdZone = document.getElementById('prd-zone-break');
      if (prdZone) prdZone.checked = data.postRunDip?.invalidateOnZoneBreak !== false;
      const prdZoneVol = document.getElementById('prd-zone-vol');
      if (prdZoneVol) prdZoneVol.checked = data.postRunDip?.invalidateRequireVolume !== false;
      const prdHard = document.getElementById('prd-hard-require');
      if (prdHard) prdHard.checked = data.postRunDip?.hardRequireSetup === true;
      const tlSens = document.getElementById('tl-sensitivity');
      if (tlSens && data.technicalLevels?.sensitivity) tlSens.value = data.technicalLevels.sensitivity;
      const tlHours = document.getElementById('tl-lookback-hours');
      if (tlHours && data.technicalLevels?.lookbackHours != null) tlHours.value = data.technicalLevels.lookbackHours;
      const tlHMin = document.getElementById('tl-lookback-min');
      if (tlHMin && data.technicalLevels?.lookbackHoursMin != null) tlHMin.value = data.technicalLevels.lookbackHoursMin;
      const tlHMax = document.getElementById('tl-lookback-max');
      if (tlHMax && data.technicalLevels?.lookbackHoursMax != null) tlHMax.value = data.technicalLevels.lookbackHoursMax;
      const tlNear = document.getElementById('tl-near-pct');
      if (tlNear && data.technicalLevels?.nearPct != null) tlNear.value = data.technicalLevels.nearPct;
      const tlImpulse = document.getElementById('tl-min-impulse');
      if (tlImpulse && data.technicalLevels?.minImpulsePct != null) tlImpulse.value = data.technicalLevels.minImpulsePct;
      const tlSrH = document.getElementById('tl-sr-lookback-hours');
      if (tlSrH && data.technicalLevels?.srLookbackHours != null) tlSrH.value = data.technicalLevels.srLookbackHours;
      const tlSrMin = document.getElementById('tl-sr-lookback-min');
      if (tlSrMin && data.technicalLevels?.srLookbackHoursMin != null) tlSrMin.value = data.technicalLevels.srLookbackHoursMin;
      const tlSrMax = document.getElementById('tl-sr-lookback-max');
      if (tlSrMax && data.technicalLevels?.srLookbackHoursMax != null) tlSrMax.value = data.technicalLevels.srLookbackHoursMax;
      const tlSwing = document.getElementById('tl-swing-strength');
      if (tlSwing && data.technicalLevels?.swingStrength) tlSwing.value = data.technicalLevels.swingStrength;
      const tlZone = document.getElementById('tl-zone-width');
      if (tlZone) {
        const zw = data.technicalLevels?.zoneWidthPct ?? data.technicalLevels?.clusterPct;
        if (zw != null) tlZone.value = zw;
      }
      const tlPivot = document.getElementById('tl-pivot');
      if (tlPivot && data.technicalLevels?.pivotWindow != null) tlPivot.value = data.technicalLevels.pivotWindow;
      const tlTouches = document.getElementById('tl-min-touches');
      if (tlTouches) {
        const mt = data.technicalLevels?.minTouchesForValid ?? data.technicalLevels?.minTouchesForStrong;
        if (mt != null) tlTouches.value = mt;
      }
      const tlFibs = document.getElementById('tl-priority-fibs');
      if (tlFibs && Array.isArray(data.technicalLevels?.prioritizeFibLevels)) {
        tlFibs.value = data.technicalLevels.prioritizeFibLevels.join(',');
      }
      const tlSec = document.getElementById('tl-secondary-fibs');
      if (tlSec && Array.isArray(data.technicalLevels?.secondaryFibLevels)) {
        tlSec.value = data.technicalLevels.secondaryFibLevels.join(',');
      }
      const tlRecent = document.getElementById('tl-prefer-recent');
      if (tlRecent) tlRecent.checked = data.technicalLevels?.preferRecentImpulse !== false;
      const tlFibZones = document.getElementById('tl-fib-zones');
      if (tlFibZones) tlFibZones.checked = data.technicalLevels?.fibTreatAsZones !== false;
      const tlRecentSup = document.getElementById('tl-prefer-recent-support');
      if (tlRecentSup) tlRecentSup.checked = data.technicalLevels?.preferRecentSupport !== false;
      const tlVol = document.getElementById('tl-favour-volume');
      if (tlVol) tlVol.checked = data.technicalLevels?.favourVolumeReaction !== false;
      const tlBreak = document.getElementById('tl-break-close');
      if (tlBreak) tlBreak.checked = data.technicalLevels?.requireBreakCloseInvalidation !== false;
      const tlHard = document.getElementById('tl-hard-filter');
      if (tlHard) tlHard.checked = data.technicalLevels?.hardFilter === true;
      const cp = data.chartPatterns || {};
      const cpSens = document.getElementById('cp-sensitivity');
      if (cpSens && cp.sensitivity) cpSens.value = cp.sensitivity;
      const cpMode = document.getElementById('cp-mode');
      if (cpMode && cp.mode) cpMode.value = cp.mode;
      const setCpNum = (id, val) => {
        const el = document.getElementById(id);
        if (el && val != null) el.value = val;
      };
      setCpNum('cp-lookback', cp.lookbackBars);
      setCpNum('cp-min-conf', cp.minConfidence);
      setCpNum('cp-breakout', cp.breakoutPct);
      setCpNum('cp-pullback-near', cp.pullbackNearPct);
      setCpNum('cp-min-pole', cp.minPoleRunPct);
      setCpNum('cp-max-flag', cp.maxFlagRangePct);
      setCpNum('cp-min-struct-drop', cp.minStructuredDropPct);
      setCpNum('cp-max-struct-drop', cp.maxStructuredDropPct);
      setCpNum('cp-vol-dry', cp.volumeDryupRatio);
      setCpNum('cp-vol-return', cp.volumeReturnRatio);
      setCpNum('cp-holder-drop', cp.holderDropPct);
      setCpNum('cp-capitulation', cp.capitulationDropPct);
      setCpNum('cp-bear-penalty', cp.bearishPenalty);
      const cpHard = document.getElementById('cp-hard-filter');
      if (cpHard) cpHard.checked = cp.hardFilter === true;
      const cpBlock = document.getElementById('cp-block-bearish');
      if (cpBlock) cpBlock.checked = cp.blockOnBearish === true;
      const patIds = [
        'ascending_triangle', 'descending_triangle', 'trendline_break',
        'holder_distribution', 'capitulation',
      ];
      patIds.forEach(function (id) {
        const el = document.getElementById('cp-pat-' + id);
        if (!el) return;
        const on = cp.patterns && cp.patterns[id] ? cp.patterns[id].enabled !== false : false;
        el.checked = on;
      });
    }

    async function loadStrategies() {
      const grid = document.getElementById('strategies-grid');
      try {
        const data = await fetchJSON('/api/strategies');
        renderStrategies(data);
        renderTradeProfilesUi(data.tradeProfiles || null);
      } catch (err) {
        if (grid) grid.innerHTML = '<div class="card text-red-300">Failed to load strategies: ' + (err.message || err) + '</div>';
      }
    }

    function renderTradeProfilesUi(tp) {
      const master = document.getElementById('trade-profiles-master');
      const smartBot = document.getElementById('smart-bot-profiles');
      const toggles = document.getElementById('trade-profiles-toggles');
      const chips = document.getElementById('trade-profiles-active-chips');
      const statusEl = document.getElementById('trade-profiles-master-status');
      if (!tp) {
        if (chips) chips.textContent = '—';
        return;
      }
      window.__tradeProfilesStatus = tp;
      try {
        renderTuningChecklist();
      } catch (_) {}
      if (master) master.checked = tp.enabled !== false;
      if (smartBot) smartBot.checked = tp.smartBotProfiles === true;
      if (statusEl) {
        statusEl.textContent = tp.enabled === false
          ? 'Multi-profile OFF (Default only)'
          : ((tp.active || []).length + ' active') +
            (tp.smartBotProfiles ? ' · Smart Bot ON' : '');
      }
      if (chips) {
        const list = tp.profiles || [];
        chips.innerHTML = list.length
          ? list.map(function (p) {
              const on = p.active;
              const color = profileColorFor(p.id) || p.color || '#94a3b8';
              return (
                '<span class="tp-chip tp-mod-tip' + (on ? '' : ' is-off') +
                '" tabindex="0" style="color:' + color +
                ';border-color:' + color + '99;background:' + color + '22" aria-label="' +
                escHtml(p.name || '') + ' modules">' +
                escHtml(p.icon || '') + ' ' + escHtml(p.name) + (on ? '' : ' (off)') +
                fmtProfileModulesPopover(p) +
                '</span>'
              );
            }).join('')
          : '—';
      }
      if (toggles) {
        toggles.innerHTML = (tp.profiles || []).map(function (p) {
          const checked = p.enabled !== false ? ' checked' : '';
          const disabled = p.id === 'default' ? ' disabled' : '';
          const er = p.exitRules || {};
          const match = p.match || {};
          const off = p.officialExitRules || {};
          const om = p.officialMatch || {};
          const pol = er.exitPolicy || {};
          const offPol = (off.exitPolicy || {});
          const sl = p.selfLearning || {};
          const slBadge = p.selfLearnBadge || '';
          const num = function (v, fallback) {
            if (v == null || v === '') return fallback != null ? fallback : '';
            return v;
          };
          const blurb =
            '<p class="tp-blurb">' + escHtml(p.description || '') + '</p>';
          const prim = Array.isArray(match.primaryPatternIds)
            ? match.primaryPatternIds
            : Array.isArray(om.primaryPatternIds)
              ? om.primaryPatternIds
              : [];
          const sec = Array.isArray(match.secondaryPatternIds)
            ? match.secondaryPatternIds
            : Array.isArray(om.secondaryPatternIds)
              ? om.secondaryPatternIds
              : [];
          const patternLine =
            prim.length || sec.length
              ? '<p class="mint text-xs tp-patterns" style="margin:0.25rem 0 0.4rem">' +
                (prim.length
                  ? '<span title="Primary patterns">★ ' +
                    escHtml(prim.join(', ')) +
                    '</span>'
                  : '') +
                (prim.length && sec.length ? ' · ' : '') +
                (sec.length
                  ? '<span title="Secondary patterns">☆ ' +
                    escHtml(sec.join(', ')) +
                    '</span>'
                  : '') +
                '</p>'
              : '';
          const risk =
            p.recommendedRisk
              ? '<div class="tp-risk"><span class="tp-risk-label">Risk</span><span class="tp-risk-value">' +
                escHtml(p.recommendedRisk) +
                '</span></div>'
              : '';
          const rules = Array.isArray(p.rulesSummary) && p.rulesSummary.length
            ? '<details class="tp-rules"><summary>Params &amp; rules</summary>' +
              '<ul class="tp-desc" style="margin:0;padding-left:1rem;list-style:disc">' +
              p.rulesSummary.slice(0, 6).map(function (r) {
                return '<li>' + escHtml(r) + '</li>';
              }).join('') +
              '</ul></details>'
            : '';
          const editable = p.id !== 'default';
          const fmtVal = function (v) {
            return v == null || v === '' ? '' : escHtml(String(v));
          };
          const numField = function (cfg) {
            return (
              '<label' + (cfg.title ? ' title="' + escHtml(cfg.title) + '"' : '') + '>' +
                escHtml(cfg.label) +
                '<input type="number" data-k="' + escHtml(cfg.key) + '"' +
                  (cfg.match ? ' data-match="1"' : '') +
                  (cfg.step != null ? ' step="' + escHtml(String(cfg.step)) + '"' : '') +
                  (cfg.min != null ? ' min="' + escHtml(String(cfg.min)) + '"' : '') +
                  (cfg.max != null ? ' max="' + escHtml(String(cfg.max)) + '"' : '') +
                  (cfg.placeholder ? ' placeholder="' + escHtml(cfg.placeholder) + '"' : '') +
                  ' value="' + fmtVal(cfg.value) + '" />' +
              '</label>'
            );
          };
          const selectField = function (cfg) {
            return (
              '<label' + (cfg.title ? ' title="' + escHtml(cfg.title) + '"' : '') + '>' +
                escHtml(cfg.label) +
                '<select data-k="' + escHtml(cfg.key) + '"' +
                  (cfg.match ? ' data-match="1"' : '') +
                  (cfg.kind ? ' data-kind="' + escHtml(cfg.kind) + '"' : '') +
                '>' +
                  cfg.options.map(function (opt) {
                    return (
                      '<option value="' + escHtml(String(opt.value)) + '"' +
                        (String(cfg.value ?? '') === String(opt.value) ? ' selected' : '') +
                      '>' + escHtml(opt.label) + '</option>'
                    );
                  }).join('') +
                '</select>' +
              '</label>'
            );
          };
          const matchValue = function (key) {
            return match[key] != null ? match[key] : om[key];
          };
          const exitValue = function (key) {
            return er[key] != null ? er[key] : off[key];
          };
          const baseEntryFields = [
            numField({
              key: 'minConviction',
              label: 'Min conviction',
              match: true,
              step: 1,
              min: 0,
              placeholder: 'default',
              value: matchValue('minConviction'),
            }),
            numField({
              key: 'minMarketCapUsd',
              label: 'Min MC Override',
              title: 'Raises this profile’s min market cap above Config Min MC. Empty = use global only.',
              match: true,
              step: 1000,
              min: 0,
              placeholder: 'global',
              value: matchValue('minMarketCapUsd'),
            }),
            numField({
              key: 'maxMarketCapUsd',
              label: 'Max MC $',
              title: 'Lane max market cap USD. Empty = no lane max.',
              match: true,
              step: 1000,
              min: 0,
              placeholder: 'default',
              value: matchValue('maxMarketCapUsd'),
            }),
            numField({
              key: 'minHolders',
              label: 'Min holders',
              title: 'Known holders only. Unknown does not fail the lane.',
              match: true,
              step: 1,
              min: 0,
              placeholder: 'default',
              value: matchValue('minHolders'),
            }),
            numField({
              key: 'maxTop10HoldPct',
              label: 'Max Top-10 %',
              title: 'Known concentration only. Global anti-rug still applies.',
              match: true,
              step: 1,
              min: 0,
              max: 100,
              placeholder: 'none',
              value: matchValue('maxTop10HoldPct'),
            }),
          ];
          const entryFields = baseEntryFields.slice();
          const qualityFields = [];
          if (p.id === 'trend_rider' || p.id === 'steady_compounder') {
            entryFields.push(
              numField({
                key: 'minTokenAgeHours',
                label: 'Min age (h)',
                match: true,
                step: 0.5,
                min: 0,
                placeholder: 'default',
                value: matchValue('minTokenAgeHours'),
              }),
              numField({
                key: 'minVolumeH1Usd',
                label: 'Min Vol H1 $',
                match: true,
                step: 100,
                min: 0,
                placeholder: 'default',
                value: matchValue('minVolumeH1Usd'),
              }),
              selectField({
                key: 'patternSensitivity',
                label: 'Pattern sensitivity',
                match: true,
                value: match.patternSensitivity != null ? match.patternSensitivity : (om.patternSensitivity || ''),
                options: [
                  { value: '', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ],
              }),
              numField({
                key: 'patternMinConfidence',
                label: 'Min pattern conf',
                match: true,
                step: 1,
                min: 0,
                max: 100,
                placeholder: 'default',
                value: matchValue('patternMinConfidence'),
              })
            );
          }
          if (p.id === 'momentum_burst') {
            entryFields.push(
              numField({
                key: 'minVolumeM5Usd',
                label: 'Min Vol M5 $',
                title: 'Raise to require stronger bursts.',
                match: true,
                step: 100,
                min: 0,
                placeholder: 'default',
                value: matchValue('minVolumeM5Usd'),
              }),
              numField({
                key: 'minBuyPressureUsd',
                label: 'Min buy pressure $',
                title: 'Known-only lane gate for recent buy pressure.',
                match: true,
                step: 100,
                min: 0,
                placeholder: 'default',
                value: matchValue('minBuyPressureUsd'),
              })
            );
          }
          if (p.id === 'dip_buyer') {
            entryFields.push(
              numField({
                key: 'minDropFromPeakPct',
                label: 'Min drop %',
                match: true,
                step: 1,
                min: 0,
                placeholder: 'default',
                value: matchValue('minDropFromPeakPct'),
              }),
              numField({
                key: 'minPriceChange24hPct',
                label: 'Min 24h run %',
                match: true,
                step: 1,
                min: 0,
                placeholder: 'default',
                value: matchValue('minPriceChange24hPct'),
              })
            );
          }
          if (p.id === 'high_win_rate' || p.id === 'smart_money_mirror') {
            entryFields.push(
              numField({
                key: 'minWalletCount',
                label: 'Min wallets',
                match: true,
                step: 1,
                min: 0,
                placeholder: 'default',
                value: matchValue('minWalletCount'),
              }),
              numField({
                key: 'minWalletQuality',
                label: 'Min wallet quality',
                match: true,
                step: 1,
                min: 0,
                max: 100,
                placeholder: 'default',
                value: matchValue('minWalletQuality'),
              }),
              selectField({
                key: 'requireCluster',
                label: 'Require cluster',
                match: true,
                kind: 'boolean',
                value:
                  match.requireCluster != null
                    ? String(match.requireCluster)
                    : om.requireCluster != null
                      ? String(om.requireCluster)
                      : '',
                options: [
                  { value: '', label: 'Default' },
                  { value: 'true', label: 'Yes' },
                  { value: 'false', label: 'No' },
                ],
              })
            );
          }
          if (p.id === 'migration_sniper') {
            entryFields.push(
              numField({
                key: 'maxTokenAgeHours',
                label: 'Max age (h)',
                match: true,
                step: 0.25,
                min: 0,
                placeholder: 'default',
                value: matchValue('maxTokenAgeHours'),
              }),
              numField({
                key: 'minBuyPressureUsd',
                label: 'Min buy pressure $',
                match: true,
                step: 100,
                min: 0,
                placeholder: 'default',
                value: matchValue('minBuyPressureUsd'),
              })
            );
          }
          if (p.id === 'reversal_scalper') {
            entryFields.push(
              numField({
                key: 'minDropFromPeakPct',
                label: 'Min drop %',
                match: true,
                step: 1,
                min: 0,
                placeholder: 'default',
                value: matchValue('minDropFromPeakPct'),
              }),
              numField({
                key: 'minBuyPressureUsd',
                label: 'Min buy pressure $',
                match: true,
                step: 100,
                min: 0,
                placeholder: 'default',
                value: matchValue('minBuyPressureUsd'),
              })
            );
          }
          if (p.id === 'smart_money_mirror') {
            entryFields.push(
              selectField({
                key: 'patternSensitivity',
                label: 'Pattern sensitivity',
                match: true,
                value: match.patternSensitivity != null ? match.patternSensitivity : (om.patternSensitivity || ''),
                options: [
                  { value: '', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ],
              }),
              numField({
                key: 'patternMinConfidence',
                label: 'Min pattern conf',
                match: true,
                step: 1,
                min: 0,
                max: 100,
                placeholder: 'default',
                value: matchValue('patternMinConfidence'),
              })
            );
          }
          if (p.id === 'high_win_rate') {
            qualityFields.push(
              '<p class="mint text-xs" style="margin:0"><strong style="color:#4ade80">Quality / specialty</strong> Keep cluster and wallet thresholds strict; use the filter below for deeper technical quality gating.</p>'
            );
          }
          const params = editable
            ? (
              '<div class="tp-params" data-tp-id="' + escHtml(p.id) + '">' +
                '<div class="tp-param-section">' +
                  '<p class="tp-param-title">Entry / lane fit</p>' +
                  '<p class="tp-param-hint">Blank fields fall back to the official profile defaults.</p>' +
                  entryFields.join('') +
                '</div>' +
                '<div class="tp-param-section">' +
                  '<p class="tp-param-title">Exit &amp; sizing</p>' +
                  numField({ key: 'takeProfitPctMin', label: 'TP min %', step: 0.5, value: num(er.takeProfitPctMin, off.takeProfitPctMin) }) +
                  numField({ key: 'takeProfitPctMax', label: 'TP max %', step: 0.5, value: num(er.takeProfitPctMax != null ? er.takeProfitPctMax : er.takeProfitPct, off.takeProfitPctMax != null ? off.takeProfitPctMax : off.takeProfitPct) }) +
                  numField({ key: 'stopLossPctMin', label: 'SL min %', step: 0.5, value: num(er.stopLossPctMin != null ? er.stopLossPctMin : er.stopLossPct, off.stopLossPctMin != null ? off.stopLossPctMin : off.stopLossPct) }) +
                  numField({ key: 'stopLossPctMax', label: 'SL max %', step: 0.5, value: num(er.stopLossPctMax != null ? er.stopLossPctMax : er.stopLossPct, off.stopLossPctMax != null ? off.stopLossPctMax : off.stopLossPct) }) +
                  numField({ key: 'hardTimeLimitSecMin', label: 'Hold min (s)', step: 5, value: num(er.hardTimeLimitSecMin, off.hardTimeLimitSecMin) }) +
                  numField({ key: 'hardTimeLimitSecMax', label: 'Hold max (s)', step: 5, value: num(er.hardTimeLimitSecMax, off.hardTimeLimitSecMax) }) +
                  numField({ key: 'sizeMultiplier', label: 'Size ×', step: 0.05, min: 0.2, max: 2, value: num(er.sizeMultiplier, off.sizeMultiplier != null ? off.sizeMultiplier : 1) }) +
                  numField({ key: 'maxTradeOverrideSol', label: 'Max Trade Override', title: 'Fixed SOL size for every trade on this profile. Overrides Config Base Trade SOL and Size ×. Empty = normal sizing.', step: 0.01, min: 0, max: 10, placeholder: 'default', value: er.maxTradeOverrideSol != null && Number(er.maxTradeOverrideSol) > 0 ? er.maxTradeOverrideSol : '' }) +
                  numField({ key: 'trailingActivationProfit', label: 'Trail arm %', title: 'Trail arms after this unrealized profit %. Empty = catalog default.', step: 0.5, min: 0, placeholder: 'default', value: exitValue('trailingActivationProfit') }) +
                  numField({ key: 'trailingStopPct', label: 'Trail %', title: 'Trailing stop % from peak after arm. Empty = catalog default.', step: 0.5, min: 0, placeholder: 'default', value: exitValue('trailingStopPct') }) +
                  numField({ key: 'momentumFailDropPct', label: 'Fail drop %', title: 'Scalp fail-drop from peak %. Empty = catalog default.', step: 0.5, min: 0, placeholder: 'default', value: exitValue('momentumFailDropPct') }) +
                  '<p class="tp-param-title" style="grid-column:1/-1;margin-top:0.5rem">Profit-lock / giveback</p>' +
                  '<p class="tp-param-hint" style="grid-column:1/-1">Arm after peak unrealized %; force sell if giveback pts from peak (e.g. 80%→50% = 30 pts).</p>' +
                  '<label title="Arm profit-lock after peak unrealized reaches this %">Lock arm %' +
                    '<input type="number" data-policy="profitLockArmPct" step="1" min="0" placeholder="default" value="' +
                    escHtml(String(pol.profitLockArmPct != null ? pol.profitLockArmPct : (offPol.profitLockArmPct != null ? offPol.profitLockArmPct : ''))) +
                  '" /></label>' +
                  '<label title="Full exit when unrealized falls this many points from peak">Giveback pts' +
                    '<input type="number" data-policy="profitGivebackPts" step="1" min="0" placeholder="default" value="' +
                    escHtml(String(pol.profitGivebackPts != null ? pol.profitGivebackPts : (offPol.profitGivebackPts != null ? offPol.profitGivebackPts : ''))) +
                  '" /></label>' +
                  '<label title="Once armed, never let unrealized fall below this % (0 = off)">Profit floor %' +
                    '<input type="number" data-policy="profitFloorPct" step="1" min="0" placeholder="default" value="' +
                    escHtml(String(pol.profitFloorPct != null ? pol.profitFloorPct : (offPol.profitFloorPct != null ? offPol.profitFloorPct : ''))) +
                  '" /></label>' +
                  '<label title="Early partial take-profit %">Early partial %' +
                    '<input type="number" data-policy="earlyPartialTpPct" step="1" min="0" placeholder="default" value="' +
                    escHtml(String(pol.earlyPartialTpPct != null ? pol.earlyPartialTpPct : (offPol.earlyPartialTpPct != null ? offPol.earlyPartialTpPct : ''))) +
                  '" /></label>' +
                '</div>' +
                (editable
                  ? '<div class="tp-param-section">' +
                      '<p class="tp-param-title">Self-learning</p>' +
                      '<label class="tp-check">' +
                        '<input type="checkbox" data-selflearn-toggle="1"' +
                          (sl.enabled ? ' checked' : '') +
                          ' onchange="toggleProfileSelfLearning(\\'' + p.id + '\\', this.checked)" />' +
                        '<span>Self-Learning ' + (sl.mode === 'auto' ? '(auto)' : '(shadow)') + '</span>' +
                      '</label>' +
                      (slBadge
                        ? '<p class="mint text-xs" style="margin:0.25rem 0;color:#4ade80">' + escHtml(slBadge) +
                          (sl.version ? ' · v' + sl.version : '') + '</p>'
                        : '<p class="mint text-xs" style="margin:0.25rem 0">Off — bot stays on fixed card knobs</p>') +
                      (sl.pendingProposal
                        ? '<p class="mint text-xs" style="margin:0.35rem 0">Proposal: ' +
                          escHtml(sl.pendingProposal.summary || '') +
                          '</p>' +
                          '<div class="tp-params-actions">' +
                            '<button type="button" class="btn btn-primary text-xs" onclick="applyProfileSelfLearnProposal(\\'' + p.id + '\\')">Apply upgrade</button>' +
                            '<button type="button" class="btn btn-secondary text-xs" onclick="rejectProfileSelfLearnProposal(\\'' + p.id + '\\')">Reject</button>' +
                          '</div>'
                        : '') +
                      '<button type="button" class="btn btn-secondary text-xs" style="margin-top:0.35rem" onclick="resetProfileSelfLearning(\\'' + p.id + '\\')">Reset learning</button>' +
                    '</div>'
                  : '') +
                (p.id === 'momentum_burst'
                  ? '<p class="mint text-xs" style="margin:0.35rem 0 0;grid-column:1/-1">1-by-1 tune: conviction → Min Vol M5 → holders/MC → TP max ↓ → Fail drop ↑ → trail arm earlier / Size × ↓. Wait ~15 closes each.</p>'
                  : '') +
                (qualityFields.length
                  ? '<div class="tp-param-section"><p class="tp-param-title">Quality / specialty</p>' + qualityFields.join('') + '</div>'
                  : '') +
                (p.id === 'high_win_rate'
                  ? (function () {
                      const qf = Object.assign(
                        {
                          enabled: true,
                          mode: 'reject',
                          minMarketCapUsd: 200000,
                          preferMarketCapUsd: 400000,
                          minLiquidityUsd: 12000,
                          minVolumeH1Usd: 6000,
                          minHolders: 80,
                          weakSetupPenalty: 40,
                          minPatternConfidence: 68,
                          cleanSetupBonus: 10,
                          applyToFibSupport: true,
                          preferFibOrSupport: true,
                        },
                        om.qualityFilter || {},
                        match.qualityFilter || {}
                      );
                      return (
                        '<div class="tp-qf">' +
                          '<p class="mint text-xs" style="margin:0"><strong style="color:#4ade80">Quality Filter</strong> — stricter MC / liq / volume / holders on technicals (HWR only)</p>' +
                          '<label class="tp-check">' +
                            '<input type="checkbox" data-qf="enabled"' + (qf.enabled !== false ? ' checked' : '') + ' />' +
                            '<span>Enable Quality Filter</span></label>' +
                          '<label>Mode<select data-qf="mode">' +
                            '<option value="reject"' + (qf.mode !== 'penalize' ? ' selected' : '') + '>Reject weak setups</option>' +
                            '<option value="penalize"' + (qf.mode === 'penalize' ? ' selected' : '') + '>Penalize only</option>' +
                          '</select></label>' +
                          '<label>Min MC $<input type="number" data-qf="minMarketCapUsd" step="1000" value="' + escHtml(String(qf.minMarketCapUsd)) + '" /></label>' +
                          '<label>Prefer MC $<input type="number" data-qf="preferMarketCapUsd" step="1000" value="' + escHtml(String(qf.preferMarketCapUsd)) + '" /></label>' +
                          '<label>Min liquidity $<input type="number" data-qf="minLiquidityUsd" step="500" value="' + escHtml(String(qf.minLiquidityUsd)) + '" /></label>' +
                          '<label>Min vol 1h $<input type="number" data-qf="minVolumeH1Usd" step="500" value="' + escHtml(String(qf.minVolumeH1Usd)) + '" /></label>' +
                          '<label>Min holders<input type="number" data-qf="minHolders" step="1" value="' + escHtml(String(qf.minHolders)) + '" /></label>' +
                          '<label>Min pattern conf<input type="number" data-qf="minPatternConfidence" step="1" min="30" max="95" value="' + escHtml(String(qf.minPatternConfidence)) + '" /></label>' +
                          '<label>Weak penalty<input type="number" data-qf="weakSetupPenalty" step="1" value="' + escHtml(String(qf.weakSetupPenalty)) + '" /></label>' +
                          '<label>Clean bonus<input type="number" data-qf="cleanSetupBonus" step="1" value="' + escHtml(String(qf.cleanSetupBonus)) + '" /></label>' +
                          '<label class="tp-check">' +
                            '<input type="checkbox" data-qf="applyToFibSupport"' + (qf.applyToFibSupport !== false ? ' checked' : '') + ' />' +
                            '<span>Apply to Fib / Support</span></label>' +
                          '<label class="tp-check">' +
                            '<input type="checkbox" data-qf="preferFibOrSupport"' + (qf.preferFibOrSupport !== false ? ' checked' : '') + ' />' +
                            '<span>Pullbacks need Fib / Support</span></label>' +
                        '</div>'
                      );
                    })()
                  : '') +
                '<div class="tp-params-actions">' +
                  '<button type="button" class="btn btn-primary" onclick="saveTradeProfileParams(\\'' + p.id + '\\')">Save</button>' +
                  '<button type="button" class="btn btn-secondary" onclick="resetTradeProfileParams(\\'' + p.id + '\\')">Reset defaults</button>' +
                  (p.hasOverrides ? '<span class="tp-override-badge">customised</span>' : '<span class="mint text-xs">official defaults</span>') +
                '</div>' +
              '</div>'
            )
            : '';
          const color = profileColorFor(p.id) || p.color || '#94a3b8';
          return (
            '<div class="tp-toggle-card" id="tp-card-' + escHtml(p.id) + '" data-tp-card="' + escHtml(p.id) + '" style="border-color:' + color + '88;box-shadow:inset 3px 0 0 ' + color + '">' +
              '<div class="tp-head">' +
                '<span class="tp-name tp-mod-tip" tabindex="0" style="color:' + color + '" aria-label="' +
                  escHtml(p.name || '') + ' modules">' +
                  escHtml(p.icon || '') + ' ' + escHtml(p.name) +
                  (p.hasOverrides ? '<span class="tp-override-badge">edited</span>' : '') +
                  (sl.enabled && slBadge
                    ? '<span class="tp-override-badge" style="background:#14532d;color:#86efac" title="Self-learning progress">' +
                      escHtml(slBadge) + '</span>'
                    : '') +
                  fmtProfileModulesPopover(p) +
                '</span>' +
                '<input type="checkbox"' + checked + disabled +
                  ' onchange="toggleTradeProfile(\\'' + p.id + '\\', this.checked)" title="Enable ' + escHtml(p.name) + '" />' +
              '</div>' +
              blurb +
              patternLine +
              risk +
              rules +
              params +
            '</div>'
          );
        }).join('');
      }
      const overviewBody = document.getElementById('trade-profiles-overview-body');
      if (overviewBody) {
        const overviewIds = [
          'scalper',
          'dip_buyer',
          'trend_rider',
          'migration_sniper',
          'high_win_rate',
          'momentum_burst',
          'steady_compounder',
          'reversal_scalper',
          'smart_money_mirror',
        ];
        const byId = {};
        (tp.profiles || []).forEach(function (p) { byId[p.id] = p; });
        const rows = overviewIds.map(function (id) { return byId[id]; }).filter(Boolean);
        overviewBody.innerHTML = rows.length
          ? rows.map(function (p) {
              const on = p.active;
              const color = profileColorFor(p.id) || p.color || '#e2e8f0';
              return (
                '<tr class="' + (on ? 'is-active' : 'is-off') + '" data-tp-score-id="' + escHtml(p.id) + '" tabindex="0" role="button" ' +
                  'onclick="focusTradeProfileCard(\\'' + p.id + '\\')" ' +
                  'onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();focusTradeProfileCard(\\'' + p.id + '\\')}" ' +
                  'title="' + (on ? 'Active — jump to controls' : 'Off — jump to controls') + '">' +
                  '<td><span class="tp-overview-name" style="color:' + color + '">' +
                    escHtml(p.icon || '') + ' ' + escHtml(p.name) +
                    (on ? '<span class="tp-overview-active-tag">on</span>' : '') +
                  '</span></td>' +
                  '<td class="tp-overview-desc">' + escHtml(p.description || '') + '</td>' +
                  '<td class="tp-overview-style">' + escHtml(p.style || '—') + '</td>' +
                  '<td><span class="tp-overview-risk">' + escHtml(p.recommendedRisk || '—') + '</span></td>' +
                  '<td class="tp-score-win" data-k="win">—</td>' +
                  '<td class="tp-score-pnl" data-k="pnl">—</td>' +
                  '<td class="tp-score-hold" data-k="hold">—</td>' +
                  '<td class="tp-score-n" data-k="n">—</td>' +
                '</tr>'
              );
            }).join('')
          : '<tr><td colspan="8" class="mint">No profiles</td></tr>';
        loadTradeProfileIntelligence();
        loadLaneDecisions();
      }
      renderAutoScoringUi(tp);
    }

    function fmtHoldSec(sec) {
      if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—';
      if (sec < 60) return Math.round(sec) + 's';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
      return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
    }

    async function loadLaneDecisions() {
      const els = document.querySelectorAll('.lane-decisions');
      if (!els.length) return;
      try {
        const data = await fetchJSON('/api/lane-decisions?limit=40');
        const list = data.decisions || [];
        let html;
        if (!list.length) {
          html = '<span class="mint">No lane fights yet — appear when Smart Bot profiles evaluate a setup</span>';
        } else {
          html = list.slice(0, 30).map(function (d) {
            const when = d.at ? new Date(d.at).toLocaleTimeString() : '';
            const winner = (d.lanes || []).find(function (l) { return l.id === d.winnerId; });
            const winColor = profileColorFor(d.winnerId) || '#e2e8f0';
            const winLabel = winner
              ? escHtml(winner.name || d.winnerId)
              : (d.winnerId ? escHtml(d.winnerId) : 'none');
            const lanes = (d.lanes || []).map(function (l) {
              const c = profileColorFor(l.id) || '#94a3b8';
              const mark = l.passed ? '✓' : '✗';
              const why = (l.reason || '').slice(0, 48);
              return (
                '<span style="color:' + c + '" title="' + escHtml(l.reason || '') + '">' +
                  mark + ' ' + escHtml(l.name || l.id) + ' ' + Number(l.score || 0).toFixed(0) +
                  (why ? ' <span class="mint">(' + escHtml(why) + ')</span>' : '') +
                '</span>'
              );
            }).join(' · ');
            let outcome = !d.winnerId ? 'skip' : (d.opened === true ? 'opened' : (d.opened === false || d.cascadeSkipReason ? 'no buy' : 'win'));
            const outcomeColor = outcome === 'opened' ? '#34d399' : (outcome === 'no buy' ? '#fbbf24' : winColor);
            const skipLine = d.cascadeSkipReason
              ? '<div class="tp-decision-why" style="color:#fbbf24">no buy: ' + escHtml(String(d.cascadeSkipReason).slice(0, 160)) + '</div>'
              : '';
            return (
              '<div class="tp-decision-row' + (!d.winnerId || outcome === 'no buy' ? ' is-skip' : '') + '" style="border-left:3px solid ' + winColor + '">' +
                '<span><strong style="color:' + winColor + '">' + winLabel + '</strong></span>' +
                '<span class="tp-decision-meta">' + escHtml(d.symbol || '') + ' · ' + escHtml(when) + '</span>' +
                '<span class="tp-decision-score" style="color:' + outcomeColor + '">' + outcome + '</span>' +
                '<div class="tp-decision-why">' + lanes + '</div>' +
                skipLine +
              '</div>'
            );
          }).join('');
        }
        els.forEach(function (el) { el.innerHTML = html; });
      } catch (err) {
        const msg = '<span class="mint">Lane log unavailable: ' + escHtml(err.message || String(err)) + '</span>';
        els.forEach(function (el) { el.innerHTML = msg; });
      }
    }

    async function loadTradeProfileIntelligence() {
      const detail = document.getElementById('tp-scoreboard-detail');
      const panel = document.getElementById('tp-learning-panel');
      try {
        const data = await fetchJSON('/api/trade-profiles/intelligence');
        window.__tpIntelligence = data;
        const rows = (data.scoreboard && data.scoreboard.rows) || [];
        const byId = {};
        rows.forEach(function (r) { byId[r.profileId] = r; });
        document.querySelectorAll('#trade-profiles-overview-body tr[data-tp-score-id]').forEach(function (tr) {
          const id = tr.getAttribute('data-tp-score-id');
          const r = byId[id];
          const winEl = tr.querySelector('[data-k="win"]');
          const pnlEl = tr.querySelector('[data-k="pnl"]');
          const holdEl = tr.querySelector('[data-k="hold"]');
          const nEl = tr.querySelector('[data-k="n"]');
          if (!r || r.trades === 0) {
            if (winEl) winEl.textContent = '—';
            if (pnlEl) pnlEl.textContent = '—';
            if (holdEl) holdEl.textContent = '—';
            if (nEl) nEl.textContent = '0';
            return;
          }
          if (winEl) {
            winEl.textContent = r.winRatePct.toFixed(0) + '%' + (r.stabilized ? ' ✓' : '');
            winEl.style.color = r.winRatePct >= 50 ? 'var(--green)' : (r.winRatePct < 40 ? '#f87171' : '');
          }
          if (pnlEl) {
            pnlEl.textContent = (r.netPnlSol >= 0 ? '+' : '') + r.netPnlSol.toFixed(4) + ' SOL';
            pnlEl.style.color = r.netPnlSol >= 0 ? 'var(--green)' : '#f87171';
          }
          if (holdEl) holdEl.textContent = fmtHoldSec(r.avgHoldSec);
          if (nEl) nEl.textContent = String(r.trades);
        });
        if (detail) {
          const mixBits = rows.filter(function (r) { return r.trades > 0; }).slice(0, 4).map(function (r) {
            const top = (r.exitMix || []).slice(0, 3).map(function (m) {
              return m.label + ' ' + m.pct.toFixed(0) + '%';
            }).join(', ');
            return escHtml(r.name) + ': ' + (top || '—');
          });
          detail.innerHTML = mixBits.length
            ? '<strong class="text-slate-300">Exit mix</strong> · ' + mixBits.join(' · ')
            : 'Scoreboard fills after closed trades (need ~' +
              ((data.scoreboard && data.scoreboard.minSampleForStabilize) || 12) +
              ' per profile to stabilize).';
        }
        if (panel) {
          const suggestions = data.suggestions || [];
          if (!suggestions.length) {
            panel.classList.add('hidden');
            panel.innerHTML = '';
          } else {
            panel.classList.remove('hidden');
            panel.innerHTML =
              '<div class="section-title" style="font-size:0.75rem;margin-bottom:0.4rem">Learning suggestions</div>' +
              '<p class="text-xs text-slate-400 mb-2">Based on closed trades — apply nudges within safe bounds (Size ×, trail, hold, quality floors). Does not raise Max Allowed Trade.</p>' +
              suggestions.map(function (s) {
                return (
                  '<div class="card mb-2" style="padding:0.55rem 0.7rem">' +
                    '<div class="flex flex-wrap items-center gap-2 justify-between">' +
                      '<strong>' + escHtml(s.profileName) + '</strong>' +
                      '<span class="mint">' + s.sampleSize + ' trades · ' +
                        Number(s.winRatePct).toFixed(0) + '% WR</span>' +
                    '</div>' +
                    '<ul class="text-xs mt-1" style="margin:0;padding-left:1rem">' +
                      (s.messages || []).map(function (m) {
                        return '<li>' + escHtml(m) + '</li>';
                      }).join('') +
                    '</ul>' +
                    '<div class="mt-2 flex flex-wrap gap-2">' +
                      '<button type="button" class="btn btn-secondary text-xs" onclick="applyTradeProfileLearning(\\'' +
                        escHtml(s.profileId) + '\\')">Apply</button>' +
                    '</div>' +
                  '</div>'
                );
              }).join('') +
              '<div class="flex flex-wrap gap-2 mt-2">' +
                '<button type="button" class="btn btn-primary text-xs" onclick="applyTradeProfileLearningAll()">Apply all suggestions</button>' +
                '<button type="button" class="btn btn-secondary text-xs" onclick="applyStabilizedEntryTightenments()" title="Phase 4: raise conviction/cluster floors on High Win-Rate / Steady Compounder when sample is stabilized and WR is soft">Apply quality entry tightenments</button>' +
              '</div>';
          }
        }
      } catch (err) {
        if (detail) detail.textContent = 'Scoreboard unavailable: ' + (err.message || err);
      }
    }

    async function applyTradeProfileLearning(profileId) {
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: profileId }),
        });
        if (data.tradeProfiles) renderTradeProfilesUi(data.tradeProfiles);
        else loadStrategies();
        alert('Applied learning nudges for ' + profileId);
      } catch (err) {
        alert('Learning apply failed: ' + (err.message || err));
      }
    }

    async function applyTradeProfileLearningAll() {
      if (!confirm('Apply all learning suggestions to matching trade profiles?')) return;
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applyAll: true }),
        });
        if (data.tradeProfiles) renderTradeProfilesUi(data.tradeProfiles);
        else loadStrategies();
        alert('Applied: ' + ((data.applied || []).join(', ') || 'none'));
      } catch (err) {
        alert('Learning apply failed: ' + (err.message || err));
      }
    }

    async function applyStabilizedEntryTightenments() {
      if (!confirm('Raise entry quality floors on stabilized High Win-Rate / Steady Compounder profiles when win rate is soft?')) return;
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applyStabilizedEntries: true }),
        });
        if (data.tradeProfiles) renderTradeProfilesUi(data.tradeProfiles);
        else loadStrategies();
        alert('Entry tightenments: ' + ((data.applied || []).join(', ') || 'none ready'));
      } catch (err) {
        alert('Entry tighten failed: ' + (err.message || err));
      }
    }

    function renderAutoScoringUi(tp) {
      const auto = tp && tp.autoScoring ? tp.autoScoring : null;
      const en = document.getElementById('auto-scoring-enabled');
      const minEl = document.getElementById('auto-scoring-min');
      const skipEl = document.getElementById('auto-scoring-skip');
      const forceEl = document.getElementById('auto-scoring-force');
      if (en) en.checked = !auto || auto.enabled !== false;
      if (minEl && auto && auto.minScore != null) minEl.value = auto.minScore;
      if (skipEl) skipEl.checked = !auto || auto.skipBelowMin !== false;
      if (forceEl) {
        const opts = ['<option value="">— none (auto pick) —</option>'];
        (tp.profiles || []).forEach(function (p) {
          if (p.id === 'default') return;
          const sel = auto && auto.forceProfileId === p.id ? ' selected' : '';
          opts.push(
            '<option value="' + escHtml(p.id) + '"' + sel + '>' +
              escHtml((p.icon || '') + ' ' + p.name) +
              (p.enabled === false ? ' (off)' : '') +
            '</option>'
          );
        });
        forceEl.innerHTML = opts.join('');
      }
      const w = (auto && auto.weights) || {};
      document.querySelectorAll('#auto-scoring-weights input[data-w]').forEach(function (inp) {
        const k = inp.getAttribute('data-w');
        if (k && w[k] != null) inp.value = w[k];
      });
      updateAutoWeightTotal();
      const decEl = document.getElementById('auto-scoring-decisions');
      if (decEl) {
        const list = tp.recentDecisions || [];
        if (!list.length) {
          decEl.innerHTML = '<span class="mint">No decisions yet — scores appear when setups are evaluated</span>';
        } else {
          decEl.innerHTML = list.slice(0, 20).map(function (d) {
            const when = d.at ? new Date(d.at).toLocaleTimeString() : '';
            const color = profileColorFor(d.profileId) || '#e2e8f0';
            const top = (d.topScores || []).slice(0, 3).map(function (t) {
              const tc = profileColorFor(t.id);
              return '<span style="color:' + tc + '">' + escHtml(t.name) + '</span>=' + Number(t.score).toFixed(0);
            }).join(' · ');
            return (
              '<div class="tp-decision-row' + (d.skipped ? ' is-skip' : '') + '" style="border-left:3px solid ' + color + '">' +
                '<span>' + escHtml(d.icon || '') + ' <strong style="color:' + color + '">' + escHtml(d.profileName || '') + '</strong></span>' +
                '<span class="tp-decision-meta">' + escHtml(d.symbol || '') + (d.forced ? ' · forced' : '') + (d.autoScored ? ' · auto' : '') + ' · ' + escHtml(when) + '</span>' +
                '<span class="tp-decision-score" style="color:' + color + '">' + (d.score != null ? Number(d.score).toFixed(1) : '—') + '</span>' +
                '<div class="tp-decision-why">' + escHtml(d.reason || '') + (top ? ' · top: ' + top : '') + '</div>' +
              '</div>'
            );
          }).join('');
        }
      }
    }

    function updateAutoWeightTotal() {
      let sum = 0;
      document.querySelectorAll('#auto-scoring-weights input[data-w]').forEach(function (inp) {
        const n = Number(inp.value);
        if (Number.isFinite(n)) sum += n;
      });
      const el = document.getElementById('auto-scoring-weight-total');
      if (el) {
        el.textContent = '(' + sum + '%)';
        el.style.color = sum === 100 ? '#94a3b8' : '#fbbf24';
      }
    }
    window.updateAutoWeightTotal = updateAutoWeightTotal;

    async function saveAutoScoringFromUi() {
      const weights = {};
      document.querySelectorAll('#auto-scoring-weights input[data-w]').forEach(function (inp) {
        const k = inp.getAttribute('data-w');
        const n = Number(inp.value);
        if (k && Number.isFinite(n)) weights[k] = n;
      });
      updateAutoWeightTotal();
      const forceEl = document.getElementById('auto-scoring-force');
      const forceVal = forceEl ? forceEl.value : '';
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoScoring: {
              enabled: !!(document.getElementById('auto-scoring-enabled') || {}).checked,
              minScore: Number((document.getElementById('auto-scoring-min') || {}).value) || 0,
              skipBelowMin: !!(document.getElementById('auto-scoring-skip') || {}).checked,
              forceProfileId: forceVal || null,
              weights: weights,
            },
          }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.saveAutoScoringFromUi = saveAutoScoringFromUi;

    async function resetAutoScoringWeights() {
      const defaults = {
        volume: 20,
        smartMoney: 16,
        tokenAge: 12,
        volatility: 11,
        supportFib: 10,
        chartPatterns: 10,
        migration: 9,
        liquidityHolders: 7,
        session: 5,
      };
      document.querySelectorAll('#auto-scoring-weights input[data-w]').forEach(function (inp) {
        const k = inp.getAttribute('data-w');
        if (k && defaults[k] != null) inp.value = defaults[k];
      });
      updateAutoWeightTotal();
      await saveAutoScoringFromUi();
    }
    window.resetAutoScoringWeights = resetAutoScoringWeights;

    function focusTradeProfileCard(id) {
      const card = document.getElementById('tp-card-' + id);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('tp-card-flash');
      setTimeout(function () { card.classList.remove('tp-card-flash'); }, 1200);
    }
    window.focusTradeProfileCard = focusTradeProfileCard;

    async function toggleMultiProfiles(enabled) {
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !!enabled }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.toggleMultiProfiles = toggleMultiProfiles;

    async function toggleSmartBotProfiles(enabled) {
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ smartBotProfiles: !!enabled }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.toggleSmartBotProfiles = toggleSmartBotProfiles;

    async function toggleTradeProfile(id, enabled) {
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, profileEnabled: !!enabled }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.toggleTradeProfile = toggleTradeProfile;

    async function saveTradeProfileParams(id) {
      const root = document.querySelector('.tp-params[data-tp-id="' + id + '"]');
      if (!root) return;
      const exitRules = {};
      const match = {};
      root.querySelectorAll('[data-k]').forEach(function (inp) {
        const k = inp.getAttribute('data-k');
        if (!k) return;
        const raw = inp.value;
        const kind = inp.getAttribute('data-kind');
        if (inp.tagName === 'SELECT') {
          if (kind === 'boolean') {
            if (raw === '') return;
            const val = raw === 'true';
            if (inp.getAttribute('data-match') === '1') match[k] = val;
            else exitRules[k] = val;
            return;
          }
          if (raw === '' || raw == null) return;
          if (inp.getAttribute('data-match') === '1') match[k] = raw;
          else exitRules[k] = raw;
          return;
        }
        // Max Trade Override: empty / 0 clears → normal sizing
        if (k === 'maxTradeOverrideSol') {
          const n = raw === '' || raw == null ? 0 : Number(raw);
          if (inp.getAttribute('data-match') === '1') return;
          exitRules[k] = Number.isFinite(n) && n > 0 ? n : 0;
          return;
        }
        // Entry/lane numeric overrides: empty / 0 clears → catalog / none
        if (
          k === 'minMarketCapUsd' ||
          k === 'maxMarketCapUsd' ||
          k === 'minTokenAgeHours' ||
          k === 'maxTokenAgeHours' ||
          k === 'minHolders' ||
          k === 'maxTop10HoldPct' ||
          k === 'minVolumeH1Usd' ||
          k === 'minVolumeM5Usd' ||
          k === 'minBuyPressureUsd' ||
          k === 'minDropFromPeakPct' ||
          k === 'minPriceChange24hPct' ||
          k === 'minWalletCount' ||
          k === 'minWalletQuality' ||
          k === 'patternMinConfidence'
        ) {
          const n = raw === '' || raw == null ? 0 : Number(raw);
          match[k] = Number.isFinite(n) && n > 0 ? n : 0;
          return;
        }
        // Fail drop / trail arm / trail %: empty / 0 clears → catalog default
        if (
          k === 'momentumFailDropPct' ||
          k === 'trailingActivationProfit' ||
          k === 'trailingStopPct'
        ) {
          const n = raw === '' || raw == null ? 0 : Number(raw);
          exitRules[k] = Number.isFinite(n) && n > 0 ? n : 0;
          return;
        }
        if (raw === '' || raw == null) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        if (inp.getAttribute('data-match') === '1') match[k] = n;
        else exitRules[k] = n;
      });
      // High Win-Rate Quality Filter (nested)
      const qfRoot = root.querySelector('.tp-qf');
      if (qfRoot) {
        const qf = {};
        qfRoot.querySelectorAll('[data-qf]').forEach(function (el) {
          const k = el.getAttribute('data-qf');
          if (!k) return;
          if (el.type === 'checkbox') {
            qf[k] = !!el.checked;
          } else if (el.tagName === 'SELECT') {
            qf[k] = el.value;
          } else {
            const n = Number(el.value);
            if (Number.isFinite(n)) qf[k] = n;
          }
        });
        match.qualityFilter = qf;
      }
      // Profit-lock / adaptive exit policy nested under exitRules.exitPolicy
      const exitPolicy = {};
      root.querySelectorAll('[data-policy]').forEach(function (inp) {
        const k = inp.getAttribute('data-policy');
        if (!k) return;
        const raw = inp.value;
        if (raw === '' || raw == null) return;
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        exitPolicy[k] = n;
      });
      if (Object.keys(exitPolicy).length) {
        exitRules.exitPolicy = Object.assign({}, erExitPolicyFromDom(root), exitPolicy);
      }
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, params: { exitRules: exitRules, match: match } }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    function erExitPolicyFromDom(root) {
      const out = {};
      root.querySelectorAll('[data-policy]').forEach(function (inp) {
        const k = inp.getAttribute('data-policy');
        if (!k) return;
        const raw = inp.value;
        if (raw === '' || raw == null) return;
        const n = Number(raw);
        if (Number.isFinite(n)) out[k] = n;
      });
      return out;
    }
    window.saveTradeProfileParams = saveTradeProfileParams;

    async function toggleProfileSelfLearning(id, enabled) {
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            profileId: id,
            selfLearningEnabled: !!enabled,
            selfLearningMode: 'shadow',
          }),
        });
        renderTradeProfilesUi(data.tradeProfiles || data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.toggleProfileSelfLearning = toggleProfileSelfLearning;

    async function applyProfileSelfLearnProposal(id) {
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: id, applySelfLearnProposal: true }),
        });
        renderTradeProfilesUi(data.tradeProfiles || data);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
    window.applyProfileSelfLearnProposal = applyProfileSelfLearnProposal;

    async function rejectProfileSelfLearnProposal(id) {
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: id, rejectSelfLearnProposal: true }),
        });
        renderTradeProfilesUi(data.tradeProfiles || data);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
    window.rejectProfileSelfLearnProposal = rejectProfileSelfLearnProposal;

    async function resetProfileSelfLearning(id) {
      if (!confirm('Reset self-learning for ' + id + '? Keeps trade memory; clears versions/proposals.')) return;
      try {
        const data = await fetchJSON('/api/trade-profiles/learning', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profileId: id, resetSelfLearning: true }),
        });
        renderTradeProfilesUi(data.tradeProfiles || data);
      } catch (err) {
        alert(err.message || String(err));
      }
    }
    window.resetProfileSelfLearning = resetProfileSelfLearning;

    async function resetTradeProfileParams(id) {
      if (!confirm('Reset ' + id + ' to official defaults?')) return;
      try {
        const data = await fetchJSON('/api/trade-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id, resetParams: true }),
        });
        renderTradeProfilesUi(data);
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }
    window.resetTradeProfileParams = resetTradeProfileParams;

    async function toggleStrategy(key, enabled) {
      const def = _strategiesStatus && (_strategiesStatus.registry || []).find(s => s.key === key);
      if (!enabled && def && (def.criticalSafety || def.source === 'core')) {
        const ok = confirm(
          '⚠ Disable ' + def.name + '?\\n\\n' +
          (def.source === 'core'
            ? 'This is a core default module. Turning it off leaves Risk sync and may reduce trade quality or safety.'
            : 'This removes a safety or quality gate and may increase losses.')
        );
        if (!ok) {
          renderStrategies(_strategiesStatus);
          return;
        }
      }
      const controls = document.getElementById('strategy-controls-' + key);
      const details = controls && controls.closest('.strategy-settings');
      const fieldset = details && details.querySelector('fieldset');
      const summary = details && details.querySelector('summary');
      if (fieldset) fieldset.disabled = !enabled;
      if (summary) summary.textContent = 'Settings' + (enabled ? '' : ' · enable strategy to edit');
      try {
        const data = await fetchJSON('/api/strategies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'set', key, enabled }),
        });
        renderStrategies(data);
        if (window.__tradeProfilesStatus) {
          renderTradeProfilesUi(window.__tradeProfilesStatus);
        }
        window._cfgLoaded = false;
        refresh();
      } catch (err) {
        alert(err.message || String(err));
        loadStrategies();
      }
    }

    async function applyStrategiesAction(action) {
      if (action === 'disable_all' && !confirm('⚠ Disable every strategy module?\\n\\nHard safety floors remain, but optional safety, quality, and exit modules will be off.')) return;
      if (action === 'high_win_rate' && !confirm('Apply 60%+ Win Rate Profile?\\n\\nFewer trades expected – prioritises high win rate.\\n\\nApplies quality ≥65, conviction ≥75, cluster ≥3, 8–10m entry window, healthy curve + momentum, aggressive dead-market exit, max 2 positions, partial TP ~+50%, trail ~22%, small bag left for runners.\\n\\nYour current settings are kept for Restore Previous.')) return;
      if (action === 'win_rate_55_60' && !confirm('Apply 55–60% Win Rate Profile?\\n\\nBalanced high-quality profile – more trades than 60%+ version.\\n\\nApplies quality ~60, conviction ~68, cluster ≥2, 10–15m entry window, liq ~$6k, holders ~40, curve preferred, momentum preferred (not mandatory), max 3 positions, partial TP ~+42%, trail ~25%.\\n\\nYour current settings are kept for Restore Previous.')) return;
      if (action === 'scalper_suite' && !confirm('Apply Scalper Suite (Standard)?\\n\\nBalanced timers/TP/SL for Micro + Momentum + Post-Migration (+ Reversal). Anti-Rug + Volume stay ON. Fine-tune after apply. Current settings kept for Restore Previous.')) return;
      if (action === 'aggressive_scalper' && !confirm('Apply Aggressive Scalper?\\n\\nFaster timers, higher TP targets, looser volume filters, slightly larger size. Anti-Rug + Volume stay ON. Fine-tune after apply.')) return;
      if (action === 'conservative_scalper' && !confirm('Apply Conservative Scalper?\\n\\nTighter stops, stricter volume/liquidity, smaller size, more aggressive dead-market exit. Anti-Rug + Volume stay ON. Fine-tune after apply.')) return;
      if (action === 'balanced' && !confirm('Apply Balanced pack?\\n\\nBest overall risk/reward start for module toggles. Does not replace Trade Profiles. Current settings kept for Restore Previous.')) return;
      if (action === 'aggressive' && !confirm('Apply Aggressive pack?\\n\\nMore opportunities, still protected. Does not replace Trade Profiles.')) return;
      if (action === 'quick_scalper' && !confirm('Apply Quick Scalper engine?\\n\\nEnables timed quick-scalp module. With Multi-profile ON, the Scalper trade profile usually owns exits — this mainly turns the engine on.\\n\\nPrefer enabling the Scalper Trade Profile instead unless you want the legacy single-engine pack.')) return;
      if (action === 'micro_scalper' && !confirm('Apply Micro-Scalper engine?\\n\\nUltra-fast holds. With Multi-profile ON, prefer Trade Profiles; this turns the micro engine on as a pack.')) return;
      if (action === 'momentum_burst' && !confirm('Apply Momentum Burst engine?\\n\\nMaps to the Momentum Burst Trade Profile when multi-profile assigns that style.')) return;
      if (action === 'post_migration_scalp' && !confirm('Apply Post-Migration Scalp engine?\\n\\nMaps to Migration Sniper Trade Profile when multi-profile assigns that style.')) return;
      if (action === 'reversal_scalp' && !confirm('Apply Reversal Scalp engine?\\n\\nMaps to Reversal Scalper Trade Profile when multi-profile assigns that style.')) return;
      if (action === 'restore' && !confirm('Restore the strategy settings saved before the preset?')) return;
      if (action === 'reset_recipe' && !confirm('Reset strategy modules to the current Risk Level recipe?\\n\\nThis turns modules on/off to match Risk and re-syncs. Manual pack overrides will be cleared.')) return;
      try {
        const data = await fetchJSON('/api/strategies', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (data.ok === false) {
          alert(data.message || 'Strategy action failed');
          return;
        }
        renderStrategies(data);
        if (window.__tradeProfilesStatus) {
          renderTradeProfilesUi(window.__tradeProfilesStatus);
        }
        window._cfgLoaded = false;
        await refresh();
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    function setStrategyIoStatus(text, kind) {
      const el = document.getElementById('strategy-io-status');
      if (!el) return;
      el.textContent = text || '';
      el.classList.toggle('is-ok', kind === 'ok');
      el.classList.toggle('is-err', kind === 'err');
    }

    function exportStrategyModulesJson() {
      setStrategyIoStatus('Exporting…', null);
      const day = new Date().toISOString().slice(0, 10);
      const a = document.createElement('a');
      a.href = '/api/strategies/export';
      a.download = 'strategy-modules-' + day + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setStrategyIoStatus('Downloaded strategy-modules-' + day + '.json', 'ok');
    }

    function triggerStrategyModulesImport() {
      const input = document.getElementById('strategy-import-file');
      if (input) {
        input.value = '';
        input.click();
      }
    }

    async function importStrategyModulesJson(ev) {
      const input = ev && ev.target ? ev.target : document.getElementById('strategy-import-file');
      const file = input && input.files && input.files[0];
      if (!file) {
        setStrategyIoStatus('Choose a .json file first', 'err');
        return;
      }
        if (!confirm('Import strategy modules + Trade Profiles from\\n' + file.name + '?\\n\\nThis applies module toggles, internal settings, and Trade Profile params (TP/SL/hold/Size ×/Max Trade/trail/fail-drop, Min MC/Max MC/holders/Top-10/Min Vol M5/conviction, Smart Bot, etc.) from the file. Risk Level field is set without re-running risk presets (so imported knobs are kept).')) {
        input.value = '';
        return;
      }
      setStrategyIoStatus('Importing…', null);
      try {
        const text = await file.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (_) {
          throw new Error('File is not valid JSON');
        }
        const data = await fetchJSON('/api/strategies/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(parsed),
        });
        if (data.ok === false) {
          throw new Error(data.error || data.message || 'Import failed');
        }
        renderStrategies(data);
        if (data.tradeProfiles) {
          renderTradeProfilesUi(data.tradeProfiles);
        } else if (window.__tradeProfilesStatus) {
          renderTradeProfilesUi(window.__tradeProfilesStatus);
        }
        window._cfgLoaded = false;
        await refresh();
        // Re-fetch strategies so the ON count matches persisted toggles (import marks recipe custom).
        try { await loadStrategies(); } catch (_) {}
        const msg = (data.import && data.import.message) || data.message || ('Imported · ' + (data.enabledCount || '?') + '/' + (data.totalCount || '?') + ' ON');
        setStrategyIoStatus(msg, 'ok');
        alert(msg);
      } catch (err) {
        const msg = err.message || String(err);
        setStrategyIoStatus(msg, 'err');
        alert('Import failed: ' + msg);
      } finally {
        if (input) input.value = '';
      }
    }
    async function resetStrategyModulesToDefaults() {
      if (!confirm(
        'Reset Strategy to baked defaults (2026-07-28 MB + lane floors)?\\n\\n' +
        'Restores strategy modules, filters, scalp engines, and Trade Profile overrides from the shipped default export.\\n\\n' +
        'Does NOT wipe wallets, paper balance, or Overview session.\\n\\nContinue?'
      )) return;
      setStrategyIoStatus('Resetting strategy defaults…', null);
      try {
        const data = await fetchJSON('/api/strategies/reset-defaults', { method: 'POST' });
        if (data.ok === false) {
          throw new Error(data.error || data.message || 'Reset failed');
        }
        renderStrategies(data);
        if (data.tradeProfiles) {
          renderTradeProfilesUi(data.tradeProfiles);
        }
        window._cfgLoaded = false;
        await refresh();
        try { await loadStrategies(); } catch (_) {}
        const msg = (data.reset && data.reset.message) || data.message || 'Strategy defaults restored';
        setStrategyIoStatus(msg, 'ok');
        alert(msg);
      } catch (err) {
        const msg = err.message || String(err);
        setStrategyIoStatus(msg, 'err');
        alert('Reset failed: ' + msg);
      }
    }
    window.exportStrategyModulesJson = exportStrategyModulesJson;
    window.triggerStrategyModulesImport = triggerStrategyModulesImport;
    window.importStrategyModulesJson = importStrategyModulesJson;
    window.resetStrategyModulesToDefaults = resetStrategyModulesToDefaults;

    function showTab(name, btn) {
      document.querySelectorAll('[data-tab-panel]').forEach(el => {
        el.classList.toggle('hidden', el.getAttribute('data-tab-panel') !== name);
      });
      document.querySelectorAll('.nav-tabs [data-tab]').forEach(el => {
        const on = el.getAttribute('data-tab') === name;
        const isZion = el.getAttribute('data-tab') === 'zion';
        el.classList.toggle('bg-emerald-600', on && !isZion);
        el.classList.toggle('text-white', on && !isZion);
        el.classList.toggle('bg-slate-800', !on && !isZion);
        el.classList.toggle('text-slate-300', !on && !isZion);
        el.classList.toggle('nav-tab-zion', isZion);
        el.classList.toggle('nav-tab-zion-active', on && isZion);
      });
      document.querySelectorAll('[data-settings-tab]').forEach(el => {
        el.classList.toggle('active', el.getAttribute('data-settings-tab') === name);
      });
      const settingsBtn = document.getElementById('settings-btn');
      if (settingsBtn) {
        settingsBtn.classList.toggle('settings-active', name === 'wallets' || name === 'config' || name === 'logs' || name === 'backtester');
      }
      closeSettingsMenu();
      try { localStorage.setItem('botDashboardTab', name); } catch (_) {}
      if ((name === 'overview' || name === 'backtester') && window._chartsNeedResize) {
        window._chartsNeedResize = false;
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
      if (name === 'backtester') {
        setTimeout(() => {
          if (window._lastBacktestCharts) updateBacktestCharts(window._lastBacktestCharts);
          refreshPerformanceCompare();
          window.dispatchEvent(new Event('resize'));
        }, 80);
      }
      if (name === 'logs') loadSystemLogs();
      if (name === 'settings' || name === 'microbots') loadStrategies();
      if (name === 'overview') loadLaneDecisions().catch(function () {});
      if (name === 'scanner') loadMarketScannerConfig();
      if (name === 'zion') loadZion();
      if (name === 'overview' || name === 'signals' || name === 'trades' || name === 'scanner') {
        ensurePosHoldTicker();
        tickOpenPositionHolds();
      }
    }

    function applyLogFilter() {
      const type = (document.getElementById('log-filter-type') || {}).value || 'all';
      const q = ((document.getElementById('log-filter-q') || {}).value || '').toLowerCase();
      document.querySelectorAll('#logs .log-entry, #logs-full .log-entry').forEach(el => {
        const t = el.getAttribute('data-type') || '';
        const text = (el.textContent || '').toLowerCase();
        const typeOk = type === 'all' || t === type || (type === 'risk' && /anti-rug|sniper|skipped|risk/i.test(text));
        const qOk = !q || text.includes(q);
        el.style.display = typeOk && qOk ? '' : 'none';
      });
    }

    let _sysLogTimer = null;
    function debounceSysLogs() {
      clearTimeout(_sysLogTimer);
      _sysLogTimer = setTimeout(loadSystemLogs, 250);
    }

    function fmtSysMeta(meta) {
      if (!meta) return '';
      try {
        return JSON.stringify(meta);
      } catch (_) {
        return String(meta);
      }
    }

    async function loadSystemLogs() {
      const box = document.getElementById('system-logs');
      const statsEl = document.getElementById('syslog-stats');
      if (!box) return;
      const level = (document.getElementById('syslog-level') || {}).value || 'all';
      const context = (document.getElementById('syslog-context') || {}).value || '';
      const q = (document.getElementById('syslog-q') || {}).value || '';
      try {
        const params = new URLSearchParams({ limit: '100', level });
        if (context) params.set('context', context);
        if (q) params.set('q', q);
        const data = await fetchJSON('/api/system-logs?' + params.toString());
        const entries = data.entries || [];
        if (statsEl && data.stats) {
          statsEl.textContent =
            data.stats.errors + ' err · ' + data.stats.warnings + ' warn · ' + data.stats.total + ' buffered';
        }
        box.innerHTML = entries.length === 0
          ? '<div class="mint">No matching system logs</div>'
          : entries.map(e => {
            const color = e.level === 'error' ? '#f87171' : e.level === 'warn' ? '#fbbf24' : '#94a3b8';
            return '<div class="log-entry" style="border-left:3px solid ' + color + ';padding-left:8px;margin:4px 0">' +
              '<span class="mint">' + new Date(e.ts).toLocaleTimeString() + '</span> ' +
              '<strong style="color:' + color + '">[' + e.level + ']</strong> ' +
              '<span style="color:#60a5fa">[' + e.context + ']</span> ' +
              '<span>' + (e.message || '') + '</span>' +
              (e.meta ? '<div class="mint" style="word-break:break-all">' + fmtSysMeta(e.meta) + '</div>' : '') +
              '</div>';
          }).join('');
      } catch (err) {
        box.innerHTML = '<div style="color:#f87171">' + (err.message || err) + '</div>';
      }
    }

    async function clearSystemLogs() {
      if (!confirm('Clear in-memory system logs? (app.log on disk is kept)')) return;
      await fetchJSON('/api/system-logs/clear', { method: 'POST' });
      loadSystemLogs();
    }
    const rangeFields = [
      'tradeAmountSol','maxAllowedTradeSol','riskMultiplier','convictionMultiplier','minProfitPercent','maxProfitPercent','stopLossPercent',
      'convergenceRequired','maxConcurrentPositions','dailyLossLimitSol','minWinRate','minLiquidity','minMarketCapUsd',
      'minDevHoldPct','maxDevHoldPct','minTopHolderPct','maxTopHolderPct','maxHolderConcentration','minTop10HolderPct',
      'minRiskScore','maxRiskScore','minEstimatedTaxPct','maxEstimatedTaxPct',
      'minActivityDays','minTradesLast30d','minVolume24hUsd','minRecentVolumeUsd','minRecentBuyVolumeUsd',
      'minHolders','minRecentActivity'
    ];
    const filterBandPairs = [
      ['minTop10HolderPct', 'maxHolderConcentration'],
      ['minDevHoldPct', 'maxDevHoldPct'],
      ['minTopHolderPct', 'maxTopHolderPct'],
      ['minRiskScore', 'maxRiskScore'],
      ['minEstimatedTaxPct', 'maxEstimatedTaxPct'],
    ];
    rangeFields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        // Keep each filter band min ≤ max when both sides are set (>0)
        for (const [minId, maxId] of filterBandPairs) {
          if (id !== minId && id !== maxId) continue;
          const minEl = document.getElementById(minId);
          const maxEl = document.getElementById(maxId);
          if (!minEl || !maxEl) continue;
          let minV = Number(minEl.value);
          let maxV = Number(maxEl.value);
          if (maxV > 0 && minV > maxV) {
            if (id === minId) {
              maxEl.value = String(minV);
              maxV = minV;
              const maxLab = document.getElementById('v-' + maxId);
              if (maxLab) maxLab.textContent = maxEl.value;
            } else {
              minEl.value = String(maxV);
              minV = maxV;
              const minLab = document.getElementById('v-' + minId);
              if (minLab) minLab.textContent = minEl.value;
            }
          }
        }
        const v = document.getElementById('v-' + id);
        if (v) v.textContent = el.value;
      });
    });

    async function fetchJSON(url, opts) {
      const timeoutMs = (opts && opts.timeoutMs) || 20000;
      const fetchOpts = Object.assign({}, opts || {});
      delete fetchOpts.timeoutMs;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, Object.assign({}, fetchOpts, { signal: ctrl.signal }));
        let data = null;
        try { data = await r.json(); } catch (_) { data = null; }
        if (!r.ok) {
          const msg = (data && data.error) || ('HTTP ' + r.status);
          throw new Error(msg);
        }
        return data;
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (err && err.name === 'AbortError') {
          throw new Error('Request timed out — GMGN may be blocked; try again for curated fallback');
        }
        if (/failed to fetch|networkerror|load failed/i.test(msg)) {
          throw new Error('Cannot reach bot server — is it running on this port?');
        }
        throw err instanceof Error ? err : new Error(msg);
      } finally {
        clearTimeout(timer);
      }
    }

    function fmtAgo(ts) {
      if (!ts) return 'never';
      const s = Math.max(0, (Date.now() - ts) / 1000);
      if (s < 60) return Math.round(s) + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      return Math.round(s / 3600) + 'h ago';
    }

    function updateDiscoveryUi(gmgn) {
      const el = document.getElementById('discovery-status');
      if (!el || !gmgn) return;
      const d = gmgn.discovery || {};
      const cfg = gmgn.discoveryConfig || {};
      const err = d.lastError ? ' · err: ' + d.lastError : '';
      const rl = d.rateLimitedUntil && d.rateLimitedUntil > Date.now()
        ? ' · rate-limited until ' + new Date(d.rateLimitedUntil).toLocaleTimeString()
        : '';
      const keyPart = gmgn.hasApiKey ? 'GMGN key ✓' : 'GMGN key MISSING';
      el.textContent =
        keyPart +
        ' · last fetch ' + fmtAgo(d.lastFetchAt) +
        ' · ok ' + fmtAgo(d.lastSuccessAt) +
        ' · ' + (d.lastWalletCount || 0) + ' wallets' +
        ' · src ' + (d.lastSource || '—') +
        ' · auto ' + Math.round((cfg.autoRefreshMs || d.autoRefreshMs || 0) / 60000) + 'm' +
        err + rl;
      const hint = document.getElementById('discovery-setup-hint');
      if (hint) {
        const parts = [];
        if (gmgn.setupHint) parts.push(gmgn.setupHint);
        hint.textContent = parts.join(' ');
        hint.style.display = parts.length ? 'block' : 'none';
      }
      const gmin = document.getElementById('disc-auto-min');
      if (gmin && document.activeElement !== gmin) {
        gmin.value = String(Math.round((cfg.autoRefreshMs || 0) / 60000));
      }
      const gstat = document.getElementById('gmgn-status');
      if (gstat) {
        gstat.textContent = gmgn.hasApiKey ? 'GMGN key OK' : 'No API key (public/curated fallback)';
      }
      const keyEl = document.getElementById('gmgn-key-status');
      if (keyEl) {
        keyEl.textContent = gmgn.hasApiKey ? 'API key ✓' : 'No API key (public/curated)';
      }
    }

    async function refreshDiscoveryStatus() {
      try {
        const data = await fetchJSON('/api/discover-wallets/status');
        if (data.gmgn) updateDiscoveryUi(data.gmgn);
        const beHint = document.getElementById('birdeye-setup-hint');
        const beLine = document.getElementById('birdeye-key-status');
        if (beLine && data.birdeye) {
          beLine.textContent = data.birdeye.hasApiKey
            ? 'Birdeye key ✓'
            : 'No BIRDEYE_API_KEY';
        }
        if (beHint && data.birdeye) {
          beHint.textContent = data.birdeye.setupHint || '';
          beHint.style.display = data.birdeye.setupHint ? 'block' : 'none';
        }
        const srcEl = document.getElementById('discovery-sources-status');
        if (srcEl && data.sources) {
          srcEl.textContent =
            'Sources — GMGN: ' + data.sources.gmgn +
            ' · Birdeye: ' + data.sources.birdeye +
            ' · Kolscan: ' + data.sources.kolscan +
            ' · Axiom: ' + (data.sources.axiom || '—') +
            ' · Photon: ' + (data.sources.photon || '—') +
            ' · BullX: ' + (data.sources.bullx || 'offline') +
            ' · DexScreener: ' + data.sources.dexscreener +
            ' · Nansen: ' + (data.sources.nansen || '—') +
            ' · Curated: ' + data.sources.curated;
        }
        if (data.nansen) updateNansenStatusUi(data.nansen);
      } catch (err) {
        const el = document.getElementById('discovery-status');
        if (el) el.textContent = err.message;
      }
    }

    async function saveDiscoveryConfig() {
      const min = Number(document.getElementById('disc-auto-min').value) || 0;
      try {
        const data = await fetchJSON('/api/gmgn/discovery', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoRefreshMs: min * 60 * 1000 }),
        });
        updateDiscoveryUi(data.gmgn);
        document.getElementById('discovery-status').textContent += ' · saved';
      } catch (err) {
        alert(err.message);
      }
    }

    function fmtLastTraded(ts, daysSince, activityLabel) {
      if (!ts) {
        return '<span class="mint">' + (activityLabel || 'Never traded') + '</span>';
      }
      const abs = new Date(ts).toLocaleString();
      const rel =
        activityLabel ||
        (daysSince != null ? Number(daysSince).toFixed(1) + 'd ago' : '');
      return abs + (rel ? ' <span class="mint">(' + rel + ')</span>' : '');
    }

    ['bt-hours','bt-max'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
        const v = document.getElementById('v-' + id);
        if (v) v.textContent = el.value;
      });
    });

    let chartBacktestPnl = null;
    let chartBacktestWl = null;
    let chartBacktestDist = null;
    let chartBacktestStrategy = null;
    let chartBacktestRisk = null;
    let _btProgressTimer = null;

    function fmtUsdShort(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      const v = Number(n);
      // Guard absurd historical exit MCs (pre-1.1.38 unit bugs)
      if (v >= 1e11) return '—';
      if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) {
        const k = v / 1e3;
        return '$' + (k >= 100 ? k.toFixed(0) : k.toFixed(k >= 10 ? 0 : 1)) + 'K';
      }
      return '$' + v.toFixed(0);
    }

    function fmtHold(ms) {
      if (ms == null || !Number.isFinite(Number(ms)) || ms < 0) return '—';
      const v = Number(ms);
      if (v < 1000) return '<1s';
      if (v < 60_000) return Math.round(v / 1000) + 's';
      if (v < 3_600_000) {
        const m = Math.floor(v / 60_000);
        const s = Math.round((v % 60_000) / 1000);
        return s > 0 ? m + 'm ' + s + 's' : m + 'm';
      }
      if (v < 86_400_000) {
        const h = Math.floor(v / 3_600_000);
        const m = Math.round((v % 3_600_000) / 60_000);
        return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
      }
      const d = Math.floor(v / 86_400_000);
      const h = Math.floor((v % 86_400_000) / 3_600_000);
      return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
    }

    function fmtCostSolUsd(costSol, costUsd, solUsd) {
      const sol = Number(costSol || 0);
      let usd = costUsd != null ? Number(costUsd) : null;
      if ((usd == null || !Number.isFinite(usd)) && solUsd != null && Number(solUsd) > 0) {
        usd = sol * Number(solUsd);
      }
      const solBit = sol.toFixed(4) + ' SOL';
      if (usd == null || !Number.isFinite(usd)) return solBit;
      return solBit + ' · $' + usd.toFixed(2);
    }

    function fmtSolShort(sol) {
      const n = Number(sol || 0);
      if (!Number.isFinite(n)) return '0';
      const abs = Math.abs(n);
      if (abs >= 1) return n.toFixed(2);
      if (abs >= 0.01) return n.toFixed(3);
      return n.toFixed(4);
    }

    function isPartialCloseSlice(p) {
      const reason = String((p && p.reason) || '');
      if (/^partial:/i.test(reason)) return true;
      if (p && p.parentPositionId && String(p.id || '').startsWith('part-')) return true;
      return false;
    }

    function tradeGroupKey(p) {
      if (p && p.parentPositionId) return 'pid:' + p.parentPositionId;
      if (isPartialCloseSlice(p) && p.mint && p.openedAt) {
        return 'mo:' + p.mint + '|' + p.openedAt;
      }
      if (p && p.id && !String(p.id).startsWith('part-')) return 'pid:' + p.id;
      if (p && p.mint && p.openedAt) return 'mo:' + p.mint + '|' + p.openedAt;
      return 'id:' + ((p && p.id) || 'unknown');
    }

    /** Shared open-position size / partial progress snapshot. */
    function openPositionProgress(p) {
      const initial = Number(
        p.initialCostSol != null && p.initialCostSol > 0
          ? p.initialCostSol
          : p.costSol || 0
      );
      const remain = Number(p.costSol || 0);
      const taken = Math.max(0, initial - remain);
      const takenPct = initial > 0 ? (taken / initial) * 100 : 0;
      const remainPct = initial > 0 ? (remain / initial) * 100 : 100;
      const hasPartial =
        takenPct >= 0.5 ||
        p.status === 'partial' ||
        p.partialSellDone === true ||
        (Number(p.solReturned) || 0) > 0;
      const solUsd = p.solUsd != null ? Number(p.solUsd) : null;
      let remainUsd = p.costUsd != null ? Number(p.costUsd) : null;
      if ((remainUsd == null || !Number.isFinite(remainUsd)) && solUsd > 0) {
        remainUsd = remain * solUsd;
      }
      let initialUsd = p.initialCostUsd != null ? Number(p.initialCostUsd) : null;
      if ((initialUsd == null || !Number.isFinite(initialUsd)) && solUsd > 0 && initial > 0) {
        initialUsd = initial * solUsd;
      }
      return {
        initial,
        remain,
        taken,
        takenPct,
        remainPct,
        hasPartial,
        remainUsd,
        initialUsd,
        solUsd,
      };
    }

    function fmtOpenStatusBadges(p, prog) {
      const badges = [];
      if (prog && prog.hasPartial) {
        badges.push(
          '<span class="pos-status-badge is-partial" title="Partial take-profits already taken">' +
            exitStyleIconHtml('partial') +
            'Partial TP Active</span>'
        );
      } else {
        badges.push(
          '<span class="pos-status-badge is-full" title="No partial exits yet — full size still open">Full</span>'
        );
      }
      if (p.trailingActive) {
        badges.push(
          '<span class="pos-status-badge is-trail" title="Trailing stop is armed">' +
            exitStyleIconHtml('trail') +
            'Trailing</span>'
        );
      }
      if (p.tradeMode === 'live') {
        badges.push(
          '<span class="pos-status-badge is-live" title="Live tracked position">Live</span>'
        );
      }
      return badges.length
        ? '<div class="pos-status-row">' + badges.join('') + '</div>'
        : '';
    }

    /** Open position size + partial take-profit progress. */
    function fmtOpenSizeCell(p) {
      const prog = openPositionProgress(p);
      if (!prog.hasPartial) {
        return (
          '<div class="pos-size-card" title="Position size">' +
            '<div class="pos-size-main">' +
              fmtCostSolUsd(prog.remain || prog.initial, prog.remainUsd, prog.solUsd) +
            '</div>' +
          '</div>'
        );
      }
      const remainUsdBit =
        prog.remainUsd != null && Number.isFinite(prog.remainUsd)
          ? (' · $' + Number(prog.remainUsd).toFixed(2))
          : '';
      return (
        '<div class="pos-size-card" title="Original ' +
          fmtCostSolUsd(prog.initial, prog.initialUsd, prog.solUsd).replace(/<[^>]+>/g, '') +
          ' · taken ' + prog.takenPct.toFixed(0) + '%">' +
          '<div class="pos-size-main">' +
            fmtSolShort(prog.remain) + ' SOL' + remainUsdBit +
          '</div>' +
          '<div class="pos-pnl-sub">left ' + prog.remainPct.toFixed(0) + '% · took ' + prog.takenPct.toFixed(0) + '%</div>' +
          '<div class="pos-partial-bar" title="' + prog.takenPct.toFixed(0) + '% taken">' +
            '<span style="width:' + Math.min(100, Math.max(0, prog.takenPct)).toFixed(1) + '%"></span>' +
          '</div>' +
        '</div>'
      );
    }

    function fmtOpenPnlCell(p) {
      const prog = openPositionProgress(p);
      const pnl = p.pnlPct != null ? Number(p.pnlPct) : null;
      const tone = pnl == null ? 'flat' : pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'flat';
      const color =
        tone === 'pos' ? 'var(--green)' : tone === 'neg' ? 'var(--red)' : 'var(--muted)';
      if (pnl == null) {
        return '<div class="pos-pnl-cell"><span class="mint">—</span></div>';
      }
      const unrealSol =
        prog.remain > 0 && Number.isFinite(pnl)
          ? prog.remain * (pnl / 100)
          : null;
      const solUsd = p.solUsd != null ? Number(p.solUsd) : NaN;
      const unrealUsd =
        unrealSol != null && Number.isFinite(solUsd) && solUsd > 0
          ? unrealSol * solUsd
          : null;
      const main =
        '<div class="pos-pnl-main" style="color:' + color + '">' +
          (pnl > 0 ? '+' : '') + pnl.toFixed(1) + '%' +
        '</div>';
      const subParts = [];
      if (unrealSol != null && Number.isFinite(unrealSol)) {
        const usdBit =
          unrealUsd != null
            ? ' · ' + (unrealUsd < 0 ? '-$' : '$') + Math.abs(unrealUsd).toFixed(2)
            : '';
        subParts.push(
          'unreal ' +
            (unrealSol >= 0 ? '+' : '') +
            fmtSolShort(unrealSol) +
            ' SOL' +
            usdBit
        );
      }
      if (prog.hasPartial) {
        subParts.push('on remaining');
        const realized = Number(p.realizedPnlSol);
        if (Number.isFinite(realized) && Math.abs(realized) > 1e-8) {
          const realizedUsd =
            Number.isFinite(solUsd) && solUsd > 0 ? realized * solUsd : null;
          subParts.push(
            'realized ' +
              (realized >= 0 ? '+' : '') +
              realized.toFixed(4) +
              ' SOL' +
              (realizedUsd != null
                ? ' · ' +
                  (realizedUsd < 0 ? '-$' : '$') +
                  Math.abs(realizedUsd).toFixed(2)
                : '')
          );
        }
      }
      return (
        '<div class="pos-pnl-cell">' +
          main +
          (subParts.length
            ? '<div class="pos-pnl-sub">' + subParts.join(' · ') + '</div>'
            : '') +
        '</div>'
      );
    }

    function fmtOpenTokenCell(p, riskBit) {
      const prog = openPositionProgress(p);
      const pnl = p.pnlPct != null ? Number(p.pnlPct) : null;
      const tone = pnl == null ? 'flat' : pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'flat';
      const badgeLabel = tone === 'pos' ? '+' : tone === 'neg' ? '−' : '·';
      const badgeTitle =
        tone === 'pos' ? 'Unrealized profit' : tone === 'neg' ? 'Unrealized loss' : 'Flat / unmarked';
      return (
        '<div class="pos-token-head">' +
          '<span class="trade-pnl-badge is-' + tone + '" title="' + badgeTitle + '" aria-label="' + badgeTitle + '">' +
            badgeLabel +
          '</span>' +
          '<div class="pos-token-main">' +
            fmtToken(p.symbol, p.name, p.mint) +
            (riskBit || '') +
            fmtOpenStatusBadges(p, prog) +
          '</div>' +
        '</div>'
      );
    }

    function labelClosedExit(slice, partialIndex, initialCostSol) {
      if (!isPartialCloseSlice(slice)) {
        const style = classifyExitStyle(slice && slice.reason);
        return (
          '<span class="trade-exit-label is-final">' +
            exitStyleIconHtml(style.key) +
            'Final Exit' +
          '</span>'
        );
      }
      const cost = Number(slice.costSol || 0);
      const pct =
        initialCostSol > 0
          ? Math.round((cost / initialCostSol) * 100)
          : null;
      const pctBit = pct != null && Number.isFinite(pct) ? ' – ' + pct + '%' : '';
      return (
        '<span class="trade-exit-label">' +
          exitStyleIconHtml('partial') +
          'Partial TP ' +
          (partialIndex + 1) +
          pctBit +
        '</span>'
      );
    }

    /** Classify raw exit reason → { key, label } for icons + summary text. */
    function classifyExitStyle(reason) {
      const r = String(reason || '').replace(/^partial:\\s*/i, '').trim();
      if (!r) return { key: 'other', label: 'Unknown' };
      const low = r.toLowerCase();
      if (/manual\\s*force\\s*sell|force\\s*sell|^manual$/i.test(r)) {
        return { key: 'manual', label: 'Manual' };
      }
      if (/trailing\\s*stop|trail\\s*exit|bag exit/i.test(r)) {
        return { key: 'trail', label: 'Trailing Stop' };
      }
      if (/hard\\s*stop|stop-?loss|stop loss/i.test(r)) {
        return { key: 'sl', label: 'Hard Stop-Loss' };
      }
      if (/max\\s*profit/i.test(r)) {
        return { key: 'tp', label: 'Max Profit' };
      }
      if (/take-?profit|full\\s*tp|\\btp\\b/i.test(low) && !/partial/i.test(low)) {
        return { key: 'tp', label: 'Full TP' };
      }
      if (/timer|time\\s*exit|deadline|scalp.*time|hold\\s*limit/i.test(r)) {
        return { key: 'timer', label: 'Timer' };
      }
      if (/dead\\s*market|dead.?vol|inactive\\s*market|volume\\s*dead/i.test(r)) {
        return { key: 'other', label: 'Dead Market' };
      }
      if (/migrat/i.test(r)) return { key: 'other', label: 'Migration' };
      if (/momentum|signal\\s*fail|invalidate|post.?run.?dip/i.test(r)) {
        return { key: 'other', label: 'Signal Fail' };
      }
      if (/bag\\s*to|bag\\s*trim/i.test(r)) return { key: 'partial', label: 'Bag Trim' };
      if (/recover|initial recovered/i.test(r)) {
        return { key: 'partial', label: 'Initial Recover' };
      }
      if (/partial\\s*sell|partial\\s*tp/i.test(r)) {
        return { key: 'partial', label: 'Partial TP' };
      }
      if (/tier\\s*\\d/i.test(r)) return { key: 'partial', label: 'Tiered TP' };
      const short = r.replace(/\\s+/g, ' ').slice(0, 28);
      return {
        key: 'other',
        label: short + (r.length > 28 ? '…' : ''),
      };
    }

    function fmtExitStyleLabel(reason) {
      return classifyExitStyle(reason).label;
    }

    function exitStyleIconHtml(key) {
      const k = String(key || 'other');
      const cls = 'exit-ico is-' + (k === 'tp' || k === 'sl' || k === 'trail' || k === 'timer' || k === 'manual' || k === 'partial' ? k : 'other');
      const title =
        k === 'tp' ? 'Take profit' :
        k === 'sl' ? 'Stop-loss' :
        k === 'trail' ? 'Trailing stop' :
        k === 'timer' ? 'Timer exit' :
        k === 'manual' ? 'Manual exit' :
        k === 'partial' ? 'Partial take-profit' :
        'Exit';
      // Compact inline SVGs (decorative; label provides accessible text)
      let svg = '';
      if (k === 'tp') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>';
      } else if (k === 'sl') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z"/></svg>';
      } else if (k === 'trail') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>';
      } else if (k === 'timer') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 1.5"/><path d="M9 2h6"/></svg>';
      } else if (k === 'manual') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13v-2a2 2 0 1 1 4 0v2"/><path d="M12 11V8a2 2 0 1 1 4 0v5"/><path d="M16 10a2 2 0 1 1 4 0v5a6 6 0 0 1-6 6h-2a6 6 0 0 1-6-6v-1a2 2 0 1 1 4 0"/></svg>';
      } else if (k === 'partial') {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 3v9h9"/></svg>';
      } else {
        svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>';
      }
      return '<span class="' + cls + '" title="' + title + '" aria-hidden="true">' + svg + '</span>';
    }

    function fmtExitStyleHtml(reason) {
      const style = classifyExitStyle(reason);
      return exitStyleIconHtml(style.key) + escHtml(style.label);
    }

    /**
     * Bold parent summary for a grouped closed trade:
     * "Cooper • 3 partial exits • Entry 0.25 SOL • Total +0.084 SOL (+31%) • Exit: Trailing Stop"
     * Hold time sits on a quieter line underneath to keep the main summary scannable.
     */
    function fmtClosedGroupSummary(g) {
      const p = g.parent || {};
      const final = g.final || p;
      const symbol = String(p.symbol || (p.mint ? String(p.mint).slice(0, 6) : 'Trade'));
      const n = (g.partials && g.partials.length) || 0;
      const partialBit = n + ' partial exit' + (n === 1 ? '' : 's');
      const size = Number(g.initialCost || p.initialCostSol || p.costSol || 0);
      const entryBit = size > 0 ? ('Entry ' + fmtSolShort(size) + ' SOL') : null;
      const pnl = Number(p.pnlSol || 0);
      const pct = Number(p.pnlPct || 0);
      const pnlTone = pnl > 0 ? 'pos' : pnl < 0 ? 'neg' : 'flat';
      const pnlColor =
        pnlTone === 'pos'
          ? 'var(--green)'
          : pnlTone === 'neg'
            ? 'var(--red)'
            : 'var(--muted)';
      const badgeLabel = pnlTone === 'pos' ? '+' : pnlTone === 'neg' ? '−' : '·';
      const badgeTitle = pnlTone === 'pos' ? 'Profitable trade' : pnlTone === 'neg' ? 'Losing trade' : 'Flat trade';
      const pnlBit =
        'Total ' +
        (pnl > 0 ? '+' : '') +
        fmtSolShort(pnl) +
        ' SOL (' +
        (pct > 0 ? '+' : '') +
        pct.toFixed(0) +
        '%)' +
        (function () {
          const rate = p.solUsd != null ? Number(p.solUsd) : NaN;
          if (!(rate > 0) || !Number.isFinite(pnl)) return '';
          const usd = pnl * rate;
          return ' · ' + (usd < 0 ? '-$' : '$') + Math.abs(usd).toFixed(2);
        })();
      const exitStyle = classifyExitStyle(final && final.reason);
      const exitBit = 'Exit: ' + exitStyleIconHtml(exitStyle.key) + escHtml(exitStyle.label);
      const openedAt = Number(p.openedAt || final.openedAt || 0);
      const closedAt = Number(
        (final && final.closedAt) || p.closedAt || g.latestAt || 0
      );
      const holdMs =
        openedAt > 0 && closedAt > openedAt ? closedAt - openedAt : null;
      const holdBit =
        holdMs != null
          ? ('Held <span class="trade-group-summary-hold">' + fmtHold(holdMs) + '</span>')
          : null;
      const parts = [
        '<span class="trade-pnl-badge is-' + pnlTone + '" title="' + badgeTitle + '" aria-label="' + badgeTitle + '">' +
          badgeLabel +
        '</span>' +
        '<span class="trade-group-summary-token">' + escHtml(symbol) + '</span>',
        '<span class="trade-group-summary-exits">' + partialBit + '</span>',
      ];
      if (entryBit) {
        parts.push('<span class="trade-group-summary-entry">' + entryBit + '</span>');
      }
      parts.push(
        '<span class="trade-group-summary-pnl is-' + pnlTone + '" style="color:' + pnlColor + '">' +
          pnlBit +
        '</span>'
      );
      parts.push(
        '<span class="trade-group-summary-exit" title="' +
          escHtml(String((final && final.reason) || '')) +
        '">' + exitBit + '</span>'
      );
      const sep = '<span class="trade-group-summary-sep" aria-hidden="true">•</span>';
      return (
        '<div class="trade-group-summary-wrap">' +
          '<div class="trade-group-summary" title="Grouped trade summary — expand for each partial exit">' +
            parts.join(sep) +
          '</div>' +
          (holdBit
            ? '<div class="trade-group-summary-sub">' + holdBit +
              ' · tap Details to see each exit</div>'
            : '<div class="trade-group-summary-sub">Tap Details to see each exit</div>') +
        '</div>'
      );
    }

    function buildClosedTradeGroups(closedFlat, openList) {
      const openKeys = new Set();
      (openList || []).forEach((p) => {
        if (p && p.id) openKeys.add('pid:' + p.id);
        if (p && p.mint && p.openedAt) openKeys.add('mo:' + p.mint + '|' + p.openedAt);
      });
      const map = new Map();
      (closedFlat || []).forEach((p) => {
        const key = tradeGroupKey(p);
        const list = map.get(key) || [];
        list.push(p);
        map.set(key, list);
      });
      const groups = [];
      map.forEach((rows, key) => {
        const partials = rows
          .filter(isPartialCloseSlice)
          .slice()
          .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
        const finals = rows
          .filter((p) => !isPartialCloseSlice(p))
          .slice()
          .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
        const final = finals.length ? finals[finals.length - 1] : null;
        if (!final && openKeys.has(key)) return; // still open — shown on Open
        const parent = final || partials[partials.length - 1];
        if (!parent) return;
        const initialCost = Number(
          parent.initialCostSol || parent.costSol || 0
        );
        const children = final ? partials : partials.slice(0, -1);
        const latestAt = Math.max(
          final ? final.closedAt || 0 : 0,
          ...partials.map((p) => p.closedAt || 0)
        );
        groups.push({
          key,
          gid: encodeURIComponent(key),
          parent,
          final,
          children,
          partials,
          initialCost,
          latestAt,
        });
      });
      groups.sort((a, b) => b.latestAt - a.latestAt);
      return groups;
    }

    function fmtTradeProfileBadge(p, opts) {
      opts = opts || {};
      const v = resolveProfileVisual(p);
      const scoreBit =
        !opts.hideScore &&
        p &&
        p.tradeProfileScore != null &&
        Number.isFinite(Number(p.tradeProfileScore))
          ? ' · ' + Number(p.tradeProfileScore).toFixed(0)
          : '';
      const tpStatus = window.__tradeProfilesStatus;
      let modulesLine = '';
      if (tpStatus) {
        const smartOn = tpStatus.smartBotProfiles === true;
        const prof = (tpStatus.profiles || []).find(function (x) {
          return x && x.id === v.id;
        });
        const eff = prof && prof.effectiveModules;
        if (!eff || eff.mode === 'inherit_all' || v.id === 'default') {
          modulesLine =
            '\\nModules: All enabled master modules (inherit)' +
            (smartOn ? '' : ' · Smart Bot Profiles off');
        } else if (eff.mode === 'allowlist') {
          const names = (eff.modules || []).map(function (m) {
            return (
              (m.name || m.key) + (m.enabled === false ? ' (off)' : '')
            );
          });
          modulesLine =
            '\\nModules: ' +
            (names.length ? names.join(', ') : '(none in allowlist)') +
            (smartOn
              ? ''
              : '\\nSmart Bot Profiles off — shared master modules apply');
        } else {
          modulesLine =
            '\\nModules: Shared master modules (Smart Bot Profiles off)';
        }
      }
      const title =
        v.name +
        (v.id ? ' (' + v.id + ')' : '') +
        scoreBit +
        (p && p.tradeProfileReason ? ' — ' + String(p.tradeProfileReason) : '') +
        modulesLine;
      const compact = opts.compact === true;
      const isZion = v.id === 'zion';
      const badgeStyle =
        'color:' + v.color + ';border-color:' + v.color + ';background:#0f172a';
      return (
        '<span class="trade-profile-badge' + (isZion ? ' is-zion' : '') +
        '" title="' + escHtml(title) + '"' +
        ' style="' + badgeStyle + '">' +
        '<span class="tpb-icon" aria-hidden="true">' + escHtml(v.icon) + '</span>' +
        (compact ? '' : '<span class="tpb-name">' + escHtml(v.name) + '</span>') +
        '</span>'
      );
    }

    function renderClosedTradeRow(p, opts) {
      opts = opts || {};
      const exitLabel = opts.exitLabel || '';
      const toggle = opts.toggleHtml || '';
      const meta = opts.metaHtml || '';
      const summary = opts.summaryHtml || '';
      const tokenInner = summary
        ? summary
        : (fmtToken(p.symbol, p.name, p.mint) + meta);
      const tokenCell = summary
        ? ('<div class="trade-group-head">' + toggle + tokenInner + '</div>')
        : (toggle + tokenInner);
      const reason =
        opts.reasonOverride != null
          ? opts.reasonOverride
          : fmtClosedReasonCell(p);
      const pnlSol = Number(p.pnlSol || 0);
      const pnlPct = Number(p.pnlPct || 0);
      const solUsd = p.solUsd != null ? Number(p.solUsd) : NaN;
      const pnlUsd =
        Number.isFinite(solUsd) && solUsd > 0
          ? pnlSol * solUsd
          : p.pnlUsd != null
            ? Number(p.pnlUsd)
            : null;
      const pnlHtml = opts.pnlHtml != null
        ? opts.pnlHtml
        : (
            '<div class="pos-pnl-cell">' +
              '<div class="pos-pnl-main" style="color:inherit">' +
                ((pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(4) + ' SOL') +
                '<span class="mint"> (' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(0) + '%)</span>' +
              '</div>' +
              (pnlUsd != null && Number.isFinite(pnlUsd)
                ? '<div class="pos-pnl-sub">' +
                  (pnlUsd < 0 ? '-$' : '$') +
                  Math.abs(pnlUsd).toFixed(2) +
                  '</div>'
                : '') +
            '</div>'
          );
      const closedCell = opts.closedHtml != null
        ? opts.closedHtml
        : (p.closedAt ? fmtTimeAgoCell(p.closedAt) : '—');
      return (
        '<tr class="' + (opts.rowClass || '') + '"' +
          (opts.groupAttr || '') +
          (opts.hidden ? ' hidden' : '') +
        '>' +
          '<td>' + tokenCell + '</td>' +
          '<td>' + fmtTradeProfileBadge(opts.profileSource || p) + '</td>' +
          '<td>' + exitLabel + fmtTokenName(p.symbol, p.name, p.mint) + '</td>' +
          '<td>' + fmtMintCa(p.mint) + '</td>' +
          '<td class="mint" title="Market cap at your buy fill (scaled to entry price)">' + fmtUsdShort(p.entryMarketCapUsd) + '</td>' +
          '<td class="mint" title="Market cap at exit fill (tracks PnL price; not a separate Dex snapshot)">' + fmtUsdShort(p.exitMarketCapUsd) + '</td>' +
          '<td class="pos-cost-cell" title="Buy-in / cost basis">' +
            fmtCostSolUsd(p.costSol, p.costUsd, p.solUsd) +
          '</td>' +
          '<td class="mint" title="Copied wallet — hover/tap for their entry MC">' +
            fmtWalletConvergence(p) +
          '</td>' +
          '<td style="color:' + (pnlSol >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
            pnlHtml +
          '</td>' +
          '<td class="mint">' + reason + '</td>' +
          '<td>' + closedCell + '</td>' +
        '</tr>'
      );
    }

    function toggleClosedTradeGroup(btn) {
      if (!btn) return;
      const gid = btn.getAttribute('data-group');
      if (!gid) return;
      if (!window._expandedClosedTradeGroups) {
        window._expandedClosedTradeGroups = {};
      }
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      const next = !expanded;
      btn.setAttribute('aria-expanded', next ? 'true' : 'false');
      btn.setAttribute('title', next ? 'Hide partial exits' : 'Show partial exits');
      const hint = btn.querySelector('.trade-group-expand-hint');
      if (hint) hint.textContent = next ? 'Hide' : 'Details';
      const parent = btn.closest('tr.trade-group-parent');
      if (parent) parent.classList.toggle('is-expanded', next);
      document.querySelectorAll('tr.trade-group-child[data-group="' + gid + '"]').forEach((row) => {
        row.hidden = !next;
      });
      if (next) window._expandedClosedTradeGroups[gid] = true;
      else delete window._expandedClosedTradeGroups[gid];
    }
    window.toggleClosedTradeGroup = toggleClosedTradeGroup;

    window._closedTradesFilter = window._closedTradesFilter || 'all';
    window._closedProfileFilter = window._closedProfileFilter || 'all';
    window._openProfileFilter = window._openProfileFilter || 'all';
    window._closedTradeGroups = window._closedTradeGroups || [];
    window._expandedClosedTradeGroups = window._expandedClosedTradeGroups || {};
    window._lastOpenPositions = window._lastOpenPositions || [];

    function syncClosedTradesFilterButtons(filter) {
      document.querySelectorAll('[data-closed-filter]').forEach((btn) => {
        const active = btn.getAttribute('data-closed-filter') === filter;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      document.querySelectorAll('[data-closed-profile-filter]').forEach((btn) => {
        const active = btn.getAttribute('data-closed-profile-filter') === (window._closedProfileFilter || 'all');
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      document.querySelectorAll('[data-open-profile-filter]').forEach((btn) => {
        const active = btn.getAttribute('data-open-profile-filter') === (window._openProfileFilter || 'all');
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function buildProfileFilterHtml(attrName, clickFn, activeId, idsMap) {
      let html =
        '<button type="button" class="closed-filter-btn' +
        ((activeId || 'all') === 'all' ? ' is-active' : '') +
        '" ' + attrName + '="all" onclick="' + clickFn + '(\\'all\\')" aria-pressed="' +
        ((activeId || 'all') === 'all' ? 'true' : 'false') +
        '">All</button>';
      idsMap.forEach((info) => {
        const active = (activeId || 'all') === info.id;
        const color = info.color || '#94a3b8';
        html +=
          '<button type="button" class="closed-filter-btn' + (active ? ' is-active' : '') +
          '" ' + attrName + '="' + info.id +
          '" onclick="' + clickFn + '(\\'' + info.id + '\\')" aria-pressed="' +
          (active ? 'true' : 'false') +
          '" style="--profile-color:' + color + '">' +
          escHtml(info.icon) + ' ' + escHtml(info.name) +
          '</button>';
      });
      return html;
    }

    function rebuildClosedProfileFilterButtons(groups) {
      const els = document.querySelectorAll('.closed-profile-filter');
      if (!els.length) return;
      const ids = new Map();
      (groups || []).forEach((g) => {
        const p = g && g.parent;
        if (!p) return;
        const v = resolveProfileVisual(p);
        if (!ids.has(v.id)) ids.set(v.id, v);
      });
      const html = buildProfileFilterHtml(
        'data-closed-profile-filter',
        'setClosedProfileFilter',
        window._closedProfileFilter || 'all',
        ids
      );
      els.forEach((el) => { el.innerHTML = html; });
    }

    function rebuildOpenProfileFilterButtons(positions) {
      const els = document.querySelectorAll('.open-profile-filter');
      if (!els.length) return;
      const ids = new Map();
      (positions || []).forEach((p) => {
        const v = resolveProfileVisual(p);
        if (!ids.has(v.id)) ids.set(v.id, v);
      });
      const html = buildProfileFilterHtml(
        'data-open-profile-filter',
        'setOpenProfileFilter',
        window._openProfileFilter || 'all',
        ids
      );
      els.forEach((el) => { el.innerHTML = html; });
    }

    function filterClosedTradeGroups(groups, filter) {
      let list = groups || [];
      if (filter === 'profit') {
        list = list.filter((g) => Number((g.parent && g.parent.pnlSol) || 0) > 0);
      } else if (filter === 'loss') {
        list = list.filter((g) => Number((g.parent && g.parent.pnlSol) || 0) < 0);
      }
      const pf = window._closedProfileFilter || 'all';
      if (pf && pf !== 'all') {
        list = list.filter((g) => resolveProfileVisual(g.parent).id === pf);
      }
      return list;
    }

    function renderClosedTradesHtml(groups) {
      rebuildClosedProfileFilterButtons(groups);
      const filtered = filterClosedTradeGroups(groups, window._closedTradesFilter || 'all');
      if (!groups || groups.length === 0) {
        return '<tr><td colspan="11" style="color:var(--muted)">No closed trades yet</td></tr>';
      }
      if (filtered.length === 0) {
        const label =
          window._closedTradesFilter === 'profit'
            ? 'No profitable closed trades'
            : window._closedTradesFilter === 'loss'
              ? 'No losing closed trades'
              : (window._closedProfileFilter && window._closedProfileFilter !== 'all')
                ? 'No closed trades for this profile'
                : 'No closed trades yet';
        return '<tr><td colspan="11" style="color:var(--muted)">' + label + '</td></tr>';
      }
      return filtered.map((g) => {
        const p = g.parent;
        const hasKids = g.children && g.children.length > 0;
        const partialN = (g.partials && g.partials.length) || 0;
        const openedAt = Number(p.openedAt || 0);
        const closedAt = Number((g.final && g.final.closedAt) || p.closedAt || 0);
        const holdMs = openedAt > 0 && closedAt > openedAt ? closedAt - openedAt : null;
        const pnlSol = Number(p.pnlSol || 0);
        const pnlPct = Number(p.pnlPct || 0);

        if (!hasKids) {
          return renderClosedTradeRow(p, {
            reasonOverride: fmtClosedReasonCell(p, {
              entryPos: p,
              exitPos: p,
            }),
            closedHtml:
              (p.closedAt ? fmtTimeAgoCell(p.closedAt) : '—') +
              (holdMs != null
                ? '<div class="mint" title="Hold from entry to exit">held ' + fmtHold(holdMs) + '</div>'
                : ''),
          });
        }

        const expandedMap = window._expandedClosedTradeGroups || {};
        const isExpanded = !!expandedMap[g.gid];
        const toggleHtml =
          '<button type="button" class="trade-group-toggle" data-group="' +
          g.gid +
          '" aria-expanded="' + (isExpanded ? 'true' : 'false') +
          '" onclick="event.stopPropagation(); toggleClosedTradeGroup(this)" title="' +
          (isExpanded ? 'Hide partial exits' : 'Show partial exits') + '">' +
          '<span class="trade-group-chevron" aria-hidden="true">▶</span>' +
          '<span class="trade-group-expand-hint">' + (isExpanded ? 'Hide' : 'Details') + '</span>' +
          '</button>';
        const finalReason = (g.final && g.final.reason) || p.reason;
        const reasonOverride = fmtClosedReasonCell(p, {
          entryPos: p,
          exitPos: g.final || p,
          partials: g.partials,
          labelHtml:
            partialN +
            ' partial' +
            (partialN === 1 ? '' : 's') +
            ' + ' +
            fmtExitStyleHtml(finalReason),
        });
        const parentRow = renderClosedTradeRow(p, {
          rowClass: 'trade-group-parent' + (isExpanded ? ' is-expanded' : ''),
          toggleHtml,
          summaryHtml: fmtClosedGroupSummary(g),
          reasonOverride,
          exitLabel:
            '<span class="trade-exit-label is-final">' +
            exitStyleIconHtml(classifyExitStyle(finalReason).key) +
            'Full trade</span><br/>',
          pnlHtml:
            '<strong style="color:' + (pnlSol >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
            (pnlSol >= 0 ? '+' : '') + fmtSolShort(pnlSol) + ' SOL</strong>' +
            '<div class="mint">(' + (pnlPct >= 0 ? '+' : '') + pnlPct.toFixed(0) + '%)</div>',
          closedHtml:
            (p.closedAt ? fmtTimeAgoCell(p.closedAt) : '—') +
            (holdMs != null
              ? '<div class="mint" title="Total hold from entry to final exit">held ' + fmtHold(holdMs) + '</div>'
              : ''),
        });
        const childList = g.children.slice();
        if (g.final) childList.push(g.final);
        const childRows = childList.map((c, idx) => {
          const isFinal = g.final && c === g.final;
          const partialIdx = isFinal ? 0 : idx;
          const isLast = idx === childList.length - 1;
          const cOpen = Number(c.openedAt || openedAt || 0);
          const cClose = Number(c.closedAt || 0);
          const cHold = cOpen > 0 && cClose > cOpen ? cClose - cOpen : null;
          return renderClosedTradeRow(c, {
            rowClass: 'trade-group-child' + (isLast ? ' trade-group-child-last' : ''),
            groupAttr: ' data-group="' + g.gid + '"',
            hidden: !isExpanded,
            profileSource: p,
            exitLabel: labelClosedExit(c, partialIdx, g.initialCost) + '<br/>',
            reasonOverride: fmtClosedReasonCell(c, {
              entryPos: p,
              exitPos: c,
              isPartialSlice: !isFinal,
              labelHtml: isFinal
                ? fmtExitStyleHtml(c.reason)
                : exitStyleIconHtml('partial') +
                  escHtml(
                    String(c.reason || '').replace(/^partial:\\s*/i, '') || '—'
                  ),
            }),
            closedHtml:
              (c.closedAt ? fmtTimeAgoCell(c.closedAt) : '—') +
              (cHold != null
                ? '<div class="mint" title="Time from entry to this exit">held ' + fmtHold(cHold) + '</div>'
                : ''),
          });
        }).join('');
        return parentRow + childRows;
      }).join('');
    }

    function paintClosedTradesTables() {
      const html = renderClosedTradesHtml(window._closedTradeGroups || []);
      document.querySelectorAll('#closed-table tbody, #trades-closed-table tbody').forEach((ctbody) => {
        ctbody.innerHTML = html;
      });
      syncClosedTradesFilterButtons(window._closedTradesFilter || 'all');
    }

    function setClosedTradesFilter(filter) {
      const next =
        filter === 'profit' || filter === 'loss' || filter === 'all' ? filter : 'all';
      window._closedTradesFilter = next;
      paintClosedTradesTables();
    }
    window.setClosedTradesFilter = setClosedTradesFilter;

    function setClosedProfileFilter(profileId) {
      window._closedProfileFilter = profileId || 'all';
      paintClosedTradesTables();
    }
    window.setClosedProfileFilter = setClosedProfileFilter;

    function setOpenProfileFilter(profileId) {
      window._openProfileFilter = profileId || 'all';
      paintOpenPositionsTables();
    }
    window.setOpenProfileFilter = setOpenProfileFilter;

    function paintOpenPositionsTables() {
      const all = window._lastOpenPositions || [];
      rebuildOpenProfileFilterButtons(all);
      const pf = window._openProfileFilter || 'all';
      const list =
        pf && pf !== 'all'
          ? all.filter((p) => resolveProfileVisual(p).id === pf)
          : all;
      if (typeof window._renderOpenPositionsHtml === 'function') {
        const html = window._renderOpenPositionsHtml(list);
        document.querySelectorAll('#positions-table tbody, #trades-positions-table tbody').forEach((ptbody) => {
          ptbody.innerHTML = html;
        });
        ensurePosHoldTicker();
        tickOpenPositionHolds();
      }
      const count = list.length;
      const total = all.length;
      const empty = total === 0;
      const label =
        pf && pf !== 'all' && total > 0
          ? count + ' / ' + total + ' open'
          : total + ' open';
      ['open-positions-badge', 'trades-open-positions-badge'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = label;
        el.setAttribute('data-empty', empty ? '1' : '0');
      });
      syncClosedTradesFilterButtons(window._closedTradesFilter || 'all');
    }

    /**
     * Colour-coded entry-source badge: Scanner (teal), Scanner+ (hybrid),
     * Copy (sky), Migration (purple). Used on positions, closed trades,
     * activity feeds, and backtest rows.
     */
    function fmtEntrySourceBadge(p, opts) {
      opts = opts || {};
      if (!p) return '';
      const entrySrc = p.entrySource;
      const names = p.sourceNames || p.walletNames || [];
      const walletName = String(p.walletName || '');
      const reason = String(p.reason || p.skipReason || '');
      const nameHit =
        names.some(function (n) {
          return /market\\s*scanner/i.test(String(n));
        }) || /market\\s*scanner/i.test(walletName);
      const reasonHit = /market\\s*scanner|\\bscanner\\b/i.test(reason);
      const isHybrid =
        entrySrc === 'hybrid' ||
        (nameHit && /\\+?\\s*wallets/i.test(walletName));
      const isScanner =
        entrySrc === 'scanner' ||
        entrySrc === 'hybrid' ||
        nameHit ||
        (reasonHit && entrySrc !== 'wallet' && entrySrc !== 'migration');
      const isMigration =
        entrySrc === 'migration' ||
        (!isScanner && /migration/i.test(String(p.source || '')) && opts.allowMigrationGuess);

      if (isMigration || entrySrc === 'migration') {
        return (
          '<span class="badge entry-src-badge" style="background:#7c3aed;color:#fff" title="Migration entry">Migration</span>'
        );
      }
      if (isScanner) {
        return (
          '<span class="badge entry-src-badge" style="background:#0d9488;color:#fff" title="Market Scanner' +
          (isHybrid ? ' + smart wallets' : ' (TA)') +
          '">' +
          (isHybrid ? 'Scanner+' : 'Scanner') +
          '</span>'
        );
      }
      if (opts.omitCopy) return '';
      // Wallet copy — sky badge (shown next to wallet name in cells)
      if (
        entrySrc === 'wallet' ||
        names.length > 0 ||
        walletName ||
        opts.forceCopy
      ) {
        return (
          '<span class="badge entry-src-badge" style="background:#0284c7;color:#fff" title="Smart-wallet copy trade">Copy</span>'
        );
      }
      return '';
    }

    /**
     * Copied wallet + converging wallets.
     * Hover (desktop) / tap (mobile) shows smart-wallet entry MC when known.
     * Addr button copies the wallet address.
     */
    function fmtWalletConvergence(p) {
      const entrySrc = p && p.entrySource;
      const namesHit = ((p && p.sourceNames) || []).some(function (n) {
        return /market\\s*scanner/i.test(String(n));
      });
      if (
        entrySrc === 'scanner' ||
        entrySrc === 'hybrid' ||
        namesHit
      ) {
        return fmtEntrySourceBadge(p);
      }
      if (entrySrc === 'migration') {
        const names = (p && p.sourceNames && p.sourceNames.length)
          ? p.sourceNames
          : null;
        const primary = names ? String(names[0]) : 'migration';
        return (
          '<div class="wallet-copy-cell">' +
            fmtEntrySourceBadge(p) +
            ' <span class="mint" title="Migration entry">' +
            primary.replace(/</g, '&lt;').slice(0, 14) +
            '</span>' +
          '</div>'
        );
      }
      const names = (p && p.sourceNames && p.sourceNames.length)
        ? p.sourceNames
        : null;
      const addrs = (p && p.sourceWallets && p.sourceWallets.length)
        ? p.sourceWallets
        : null;
      const total = names ? names.length : (addrs ? addrs.length : 0);
      if (total <= 0) {
        const bare = fmtEntrySourceBadge(p);
        return bare
          ? '<div class="wallet-copy-cell">' + bare + '</div>'
          : '<span class="mint">—</span>';
      }
      const primaryAddr = addrs && addrs[0] ? String(addrs[0]) : '';
      const primary = names
        ? String(names[0])
        : primaryAddr
          ? primaryAddr.slice(0, 4) + '…' + primaryAddr.slice(-4)
          : 'wallet';
      const others = total - 1;
      const srcMc = p.sourceEntryMcUsd != null
        ? Number(p.sourceEntryMcUsd)
        : (p.smartWalletEntryMarketCapUsd != null
          ? Number(p.smartWalletEntryMarketCapUsd)
          : null);
      const yourMc = p.entryMarketCapUsd != null
        ? Number(p.entryMarketCapUsd)
        : null;
      const srcMcLabel = srcMc != null && Number.isFinite(srcMc) && srcMc > 0
        ? fmtUsdShort(srcMc)
        : null;
      const yourMcLabel = yourMc != null && Number.isFinite(yourMc) && yourMc > 0
        ? fmtUsdShort(yourMc)
        : null;
      let tipText;
      if (srcMcLabel) {
        tipText = 'Smart wallet entry MC ' + srcMcLabel;
        if (yourMcLabel && yourMcLabel !== srcMcLabel) {
          tipText += ' · your buy MC ' + yourMcLabel;
        }
      } else if (yourMcLabel) {
        tipText = 'Wallet entry MC not stored · your buy MC ' + yourMcLabel;
      } else {
        tipText =
          'Copied wallet' +
          (others > 0 ? ' (+' + others + ' converged)' : '') +
          ' · entry MC not stored';
      }
      if (primaryAddr) tipText += ' · ' + primaryAddr;
      const tipEsc = tipText.replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const label = primary.replace(/</g, '&lt;') +
        (others > 0 ? ' <span class="mint">+' + others + '</span>' : '');
      const mcChip = srcMcLabel
        ? '<span class="mint" style="font-size:0.68rem">MC ' + srcMcLabel + '</span>'
        : (yourMcLabel
          ? '<span class="mint" style="font-size:0.68rem" title="Fallback: your fill MC">buy ' + yourMcLabel + '</span>'
          : '');
      const copyBtn = primaryAddr
        ? '<button type="button" class="ca-btn" data-addr="' + escAttr(primaryAddr) +
          '" onclick="copyWalletAddress(event)" title="Copy wallet address">Addr</button>'
        : '';
      return (
        '<div class="wallet-copy-cell">' +
          '<div class="wallet-copy-row">' +
            '<span class="badge entry-src-badge" style="background:#0284c7;color:#fff" title="' + tipEsc +
            '">Copy</span>' +
            '<span class="pos-hold wallet-mc-tip" style="color:#38bdf8" title="' + tipEsc +
            '" onclick="togglePosHoldEntry(this)" role="button" tabindex="0">' +
              '<span class="pos-hold-dur">' + label + '</span>' +
              '<span class="pos-hold-entry">' + tipEsc + '</span>' +
            '</span>' +
            copyBtn +
          '</div>' +
          (mcChip ? '<div class="wallet-copy-row">' + mcChip + '</div>' : '') +
        '</div>'
      );
    }

    /** Compact signed unrealized P&L: +0.12 SOL · $18.40 */
    function fmtUnrealizedSolUsd(sol, usd) {
      const n = Number(sol || 0);
      const sign = n > 0 ? '+' : '';
      const solBit = sign + n.toFixed(4) + ' SOL';
      if (usd == null || !Number.isFinite(Number(usd))) return solBit;
      const u = Number(usd);
      const usdBit = (u < 0 ? '-$' : '$') + Math.abs(u).toFixed(2);
      return solBit + ' · ' + usdBit;
    }

    /** Unrealized SOL from open positions — same mark basis as Open Positions pnlPct. */
    function sumOpenUnrealized(open) {
      let sol = 0;
      let marked = 0;
      let solUsd = null;
      for (const p of open || []) {
        const pct = p.pnlPct != null ? Number(p.pnlPct) : NaN;
        if (!Number.isFinite(pct)) continue;
        const cost = Number(p.costSol || 0);
        if (!Number.isFinite(cost) || cost <= 0) continue;
        sol += cost * (pct / 100);
        marked += 1;
        if (p.solUsd != null && Number(p.solUsd) > 0) solUsd = Number(p.solUsd);
      }
      const usd = solUsd != null && Number.isFinite(solUsd) ? sol * solUsd : null;
      return { sol, usd, marked, openN: (open || []).length };
    }

    function fmtVolH1(vol, txns) {
      if (vol == null || !Number.isFinite(Number(vol))) {
        return '<span class="mint">—</span>';
      }
      const v = Number(vol);
      const color = v <= 0 ? 'var(--red)' : (v < 50 ? '#fbbf24' : 'inherit');
      const tip = 'Rolling 1h USD volume' +
        (txns != null ? ' · ' + Number(txns) + ' txns/hr' : '');
      const label = v >= 1000
        ? '$' + (v / 1000).toFixed(1) + 'K'
        : '$' + (v < 10 ? v.toFixed(1) : v.toFixed(0));
      return '<span class="pos-vol-cell" style="color:' + color + '" title="' + tip + '">' +
        label + '</span>';
    }

    /** 0–100 quality score for an open position (profile score preferred). */
    function computeOpenQualityScore(p) {
      if (!p) return null;
      if (p.tradeProfileScore != null && Number.isFinite(Number(p.tradeProfileScore))) {
        return Math.round(Math.max(0, Math.min(100, Number(p.tradeProfileScore))));
      }
      let score = 35;
      let used = false;
      if (p.convictionScore != null && Number.isFinite(Number(p.convictionScore))) {
        score += Math.min(30, Number(p.convictionScore) * 0.3);
        used = true;
      }
      if (p.scannerConfluence != null && Number.isFinite(Number(p.scannerConfluence))) {
        score += Math.min(20, Number(p.scannerConfluence) * 0.2);
        used = true;
      }
      if (p.antiRug && p.antiRug.riskScore != null && Number.isFinite(Number(p.antiRug.riskScore))) {
        score += Math.max(0, 15 - Number(p.antiRug.riskScore) * 0.15);
        used = true;
      }
      const wallets = (p.sourceNames && p.sourceNames.length) || (p.sourceWallets && p.sourceWallets.length) || 0;
      if (wallets > 0) {
        score += Math.min(10, wallets * 3);
        used = true;
      }
      if (p.tradeProfileReason || p.entrySource || p.scannerPlaybook) used = true;
      if (!used) return null;
      return Math.round(Math.max(0, Math.min(100, score)));
    }

    function buildOpenEntryReasonDetail(p) {
      const lines = [];
      if (!p) {
        return { hasInfo: false, quality: null, qualityEstimated: false, lines: [] };
      }
      const profileName =
        p.tradeProfileName ||
        (p.tradeProfileId ? String(p.tradeProfileId).replace(/_/g, ' ') : null);
      if (profileName) {
        lines.push({
          label: 'Profile',
          text:
            profileName +
            (p.tradeProfileReason ? ' — ' + String(p.tradeProfileReason) : ''),
        });
      } else if (p.tradeProfileReason) {
        lines.push({ label: 'Profile', text: String(p.tradeProfileReason) });
      }

      if (p.entrySource) {
        const srcLabel =
          p.entrySource === 'wallet'
            ? 'Smart wallet copy'
            : p.entrySource === 'scanner'
              ? 'Market scanner'
              : p.entrySource === 'migration'
                ? 'Migration event'
                : p.entrySource === 'hybrid'
                  ? 'Hybrid (wallet + scanner)'
                  : p.entrySource === 'zion'
                    ? 'Triggered manually via Zion / KOL Scan'
                    : String(p.entrySource);
        lines.push({ label: 'Entry path', text: srcLabel });
      } else if (p.tradeProfileId === 'zion') {
        lines.push({
          label: 'Entry path',
          text: 'Triggered manually via Zion / KOL Scan',
        });
      }

      if (p.entrySource === 'zion' || p.tradeProfileId === 'zion') {
        lines.push({
          label: 'Zion',
          text: 'Manual Place Trade from a KOL scanner offer — not auto-bought by copy or Market Scanner.',
        });
      }

      if (p.entryMarketCapUsd != null && Number(p.entryMarketCapUsd) > 0) {
        let mcText = 'Entered at ' + fmtUsdShort(p.entryMarketCapUsd) + ' MC';
        if (
          p.sourceEntryMcUsd != null &&
          Number(p.sourceEntryMcUsd) > 0 &&
          Math.abs(Number(p.sourceEntryMcUsd) - Number(p.entryMarketCapUsd)) /
            Number(p.entryMarketCapUsd) >
            0.02
        ) {
          mcText +=
            ' (source wallet bought near ' +
            fmtUsdShort(p.sourceEntryMcUsd) +
            ')';
        }
        lines.push({ label: 'Market cap', text: mcText });
      }

      if (p.convictionScore != null && Number.isFinite(Number(p.convictionScore))) {
        lines.push({
          label: 'Conviction',
          text: String(Number(p.convictionScore).toFixed(0)) + ' / 100',
        });
      }

      const techBits = [];
      if (p.technicalLevels && p.technicalLevels.summary) {
        techBits.push(String(p.technicalLevels.summary));
      }
      if (p.candleSource) {
        techBits.push(
          p.candleSource === 'real'
            ? 'Real candle data'
            : 'Synthetic / proxy candles'
        );
      }
      if (p.shortTermStrategyId) {
        techBits.push(
          'Scalp engine: ' + String(p.shortTermStrategyId).replace(/_/g, ' ')
        );
      } else if (p.scalpMode) {
        techBits.push('Scalp / short-term exit mode armed');
      }
      if (techBits.length) {
        lines.push({ label: 'Technicals', text: techBits.join(' · ') });
      }

      if (p.scannerPlaybook || p.scannerConfluence != null) {
        const bits = [];
        if (p.scannerPlaybook) bits.push(String(p.scannerPlaybook).replace(/_/g, ' '));
        if (p.scannerConfluence != null && Number.isFinite(Number(p.scannerConfluence))) {
          bits.push('confluence ' + Number(p.scannerConfluence).toFixed(0));
        }
        lines.push({ label: 'Scanner', text: bits.join(' · ') });
      }

      const walletNames = (p.sourceNames || []).filter(Boolean);
      if (walletNames.length) {
        lines.push({
          label: 'Smart wallets',
          text: walletNames.slice(0, 6).join(', ') + (walletNames.length > 6 ? '…' : ''),
        });
      } else if (p.sourceWallets && p.sourceWallets.length) {
        lines.push({
          label: 'Smart wallets',
          text:
            p.sourceWallets.length +
            ' wallet' +
            (p.sourceWallets.length === 1 ? '' : 's') +
            ' (addresses on file)',
        });
      }

      if (p.volumeH1Usd != null && Number(p.volumeH1Usd) > 0) {
        lines.push({
          label: 'Volume / flow',
          text:
            '1h vol ' +
            fmtUsdShort(p.volumeH1Usd) +
            (p.txnsH1 != null ? ' · ' + p.txnsH1 + ' txns' : ''),
        });
      }

      if (p.antiRug) {
        const ar = p.antiRug;
        const flags = (ar.flags || []).slice(0, 4).join(', ');
        lines.push({
          label: 'Risk / anti-rug',
          text:
            'score ' +
            (ar.riskScore != null ? ar.riskScore : '?') +
            (ar.riskLevel ? ' (' + ar.riskLevel + ')' : '') +
            (flags ? ' · ' + flags : ''),
        });
      }

      const qualityRaw = computeOpenQualityScore(p);
      const qualityEstimated =
        qualityRaw != null &&
        !(
          p.tradeProfileScore != null &&
          Number.isFinite(Number(p.tradeProfileScore))
        );

      return {
        hasInfo: lines.length > 0 || qualityRaw != null,
        quality: qualityRaw,
        qualityEstimated,
        lines,
      };
    }

    function renderOpenReasonPanelHtml(detail, opts) {
      opts = opts || {};
      const title = opts.title || 'Entry reason';
      if (!detail || !detail.hasInfo) {
        return (
          '<div class="pmi-title">' +
          escHtml(title) +
          '</div><div class="pmi-empty">No info available</div>'
        );
      }
      let html = '<div class="pmi-title">' + escHtml(title) + '</div>';
      if (detail.quality != null) {
        const q = detail.quality;
        const cls = q >= 70 ? '' : q >= 45 ? ' is-mid' : ' is-low';
        html +=
          '<div class="pmi-score' +
          cls +
          '">Quality ' +
          q +
          ' / 100' +
          (detail.qualityEstimated ? ' · est.' : '') +
          '</div>';
      }
      html += detail.lines
        .map(function (line) {
          return (
            '<div class="pmi-line"><strong>' +
            escHtml(line.label) +
            ':</strong> ' +
            escHtml(line.text) +
            '</div>'
          );
        })
        .join('');
      return html;
    }

    function explainExitReason(rawReason, style) {
      const r = String(rawReason || '').trim();
      const low = r.toLowerCase();
      const key = (style && style.key) || 'other';
      if (key === 'manual' || /manual\\s*force\\s*sell|force\\s*sell/i.test(r)) {
        return 'You manually forced a sell from the dashboard.';
      }
      if (key === 'trail' || /trailing\\s*stop|trail\\s*exit|bag exit/i.test(r)) {
        return 'Price pulled back from the peak enough to hit the trailing stop.';
      }
      if (key === 'sl' || /hard\\s*stop|stop-?loss|stop loss/i.test(r)) {
        return 'Price hit the hard stop-loss level frozen on this position.';
      }
      if (/max\\s*profit/i.test(r)) {
        return 'Hit the max-profit ceiling and fully exited.';
      }
      if (key === 'tp' || (/take-?profit|full\\s*tp/i.test(low) && !/partial/i.test(low))) {
        return 'Reached the take-profit target and closed the remaining size.';
      }
      if (key === 'timer' || /timer|time\\s*exit|deadline|scalp.*time|hold\\s*limit/i.test(r)) {
        return 'Hold-time / scalp timer expired — timed exit fired.';
      }
      if (/dead\\s*market|dead.?vol|inactive\\s*market|volume\\s*dead/i.test(r)) {
        return 'Volume / activity dried up (dead-market exit) after the min-hold window.';
      }
      if (/migrat/i.test(r)) {
        return 'Exit tied to a migration / graduation event rule.';
      }
      if (/momentum|signal\\s*fail|invalidate|post.?run.?dip/i.test(r)) {
        return 'Entry thesis invalidated (momentum fade / signal fail) — exited early.';
      }
      if (/bag\\s*to|bag\\s*trim/i.test(r)) {
        return 'Bag trim / residual size reduced after prior profits.';
      }
      if (/recover|initial recovered/i.test(r)) {
        return 'Initial cost recovered — banked a recovery / breakeven-style scale-out.';
      }
      if (/partial\\s*sell|partial\\s*tp|tier\\s*\\d/i.test(r) || key === 'partial') {
        return 'Partial take-profit / scale-out — only a slice of the position was sold.';
      }
      if (/profile\\s*early|adaptive/i.test(r)) {
        return 'Profile adaptive exit policy closed (or trimmed) this trade.';
      }
      if (r) {
        return 'Closed by the exit engine using the raw reason logged below.';
      }
      return 'Exit reason was not recorded on this row.';
    }

    function buildClosedExitReasonDetail(p, opts) {
      opts = opts || {};
      const lines = [];
      if (!p) {
        return { hasInfo: false, lines: [] };
      }
      const raw = String(p.reason || '').trim();
      const clean = raw.replace(/^partial:\\s*/i, '').trim();
      const style = classifyExitStyle(raw);
      lines.push({ label: 'Exit type', text: style.label });
      if (opts.isPartialSlice) {
        lines.push({
          label: 'Slice',
          text: 'Partial take-profit / scale-out leg (not the final close)',
        });
      }
      if (clean) {
        lines.push({ label: 'Logged reason', text: clean });
      }
      const why = explainExitReason(clean, style);
      if (why) lines.push({ label: 'Why', text: why });

      const pnlSol = Number(p.pnlSol);
      const pnlPct = Number(p.pnlPct);
      if (Number.isFinite(pnlSol) || Number.isFinite(pnlPct)) {
        let pnlText = '';
        if (Number.isFinite(pnlSol)) {
          pnlText += (pnlSol >= 0 ? '+' : '') + pnlSol.toFixed(4) + ' SOL';
        }
        if (Number.isFinite(pnlPct)) {
          pnlText +=
            (pnlText ? ' · ' : '') +
            (pnlPct >= 0 ? '+' : '') +
            pnlPct.toFixed(1) +
            '%';
        }
        lines.push({ label: 'Result', text: pnlText || '—' });
      }

      if (p.exitMarketCapUsd != null && Number(p.exitMarketCapUsd) > 0) {
        let mcText = 'Exited at ' + fmtUsdShort(p.exitMarketCapUsd) + ' MC';
        if (p.entryMarketCapUsd != null && Number(p.entryMarketCapUsd) > 0) {
          const entry = Number(p.entryMarketCapUsd);
          const exit = Number(p.exitMarketCapUsd);
          const chg = ((exit - entry) / entry) * 100;
          if (Number.isFinite(chg)) {
            mcText +=
              ' (vs buy ' +
              fmtUsdShort(entry) +
              ' · ' +
              (chg >= 0 ? '+' : '') +
              chg.toFixed(0) +
              '%)';
          }
        }
        lines.push({ label: 'Exit MC', text: mcText });
      }

      const openedAt = Number(p.openedAt || 0);
      const closedAt = Number(p.closedAt || 0);
      if (openedAt > 0 && closedAt > openedAt) {
        lines.push({
          label: 'Hold time',
          text: fmtHold(closedAt - openedAt),
        });
      }

      const rules = [];
      if (p.takeProfitPct != null && Number.isFinite(Number(p.takeProfitPct))) {
        rules.push('TP +' + Number(p.takeProfitPct).toFixed(0) + '%');
      }
      if (p.stopLossPct != null && Number.isFinite(Number(p.stopLossPct))) {
        rules.push('SL ' + Number(p.stopLossPct).toFixed(0) + '%');
      }
      if (
        p.trailingStopPct != null &&
        Number.isFinite(Number(p.trailingStopPct))
      ) {
        rules.push('trail ' + Number(p.trailingStopPct).toFixed(0) + '%');
      }
      if (
        p.trailingActivationProfit != null &&
        Number.isFinite(Number(p.trailingActivationProfit))
      ) {
        rules.push(
          'trail arm @ +' + Number(p.trailingActivationProfit).toFixed(0) + '%'
        );
      }
      if (p.trailingActive === true) {
        rules.push('trail was armed');
      }
      if (rules.length) {
        lines.push({ label: 'Exit rules', text: rules.join(' · ') });
      }

      if (p.shortTermStrategyId || p.scalpMode) {
        lines.push({
          label: 'Scalp',
          text: p.shortTermStrategyId
            ? String(p.shortTermStrategyId).replace(/_/g, ' ')
            : 'Short-term / scalp mode',
        });
      }

      const partials = opts.partials || opts.groupPartials || [];
      if (partials.length && !opts.isPartialSlice) {
        const bits = partials.slice(0, 4).map(function (s, i) {
          const st = classifyExitStyle(s && s.reason);
          const pct =
            s && s.pnlPct != null && Number.isFinite(Number(s.pnlPct))
              ? ' ' +
                (Number(s.pnlPct) >= 0 ? '+' : '') +
                Number(s.pnlPct).toFixed(0) +
                '%'
              : '';
          return '#' + (i + 1) + ' ' + st.label + pct;
        });
        lines.push({
          label: 'Earlier partials',
          text:
            bits.join(' · ') +
            (partials.length > 4 ? ' · +' + (partials.length - 4) + ' more' : ''),
        });
      }

      return {
        hasInfo: lines.length > 0,
        lines: lines,
        styleKey: style.key,
        styleLabel: style.label,
      };
    }

    function renderExitReasonPanelHtml(detail) {
      if (!detail || !detail.hasInfo) {
        return (
          '<div class="pmi-title pmi-title-exit">Exit</div>' +
          '<div class="pmi-empty">No exit info available</div>'
        );
      }
      let html = '<div class="pmi-title pmi-title-exit">Exit</div>';
      html += detail.lines
        .map(function (line) {
          return (
            '<div class="pmi-line"><strong>' +
            escHtml(line.label) +
            ':</strong> ' +
            escHtml(line.text) +
            '</div>'
          );
        })
        .join('');
      return html;
    }

    function renderDualReasonPanelHtml(payload) {
      return (
        '<div class="pmi-dual">' +
        '<div class="pmi-col pmi-col-open">' +
        renderOpenReasonPanelHtml(payload && payload.open, { title: 'Open' }) +
        '</div>' +
        '<div class="pmi-col pmi-col-exit">' +
        renderExitReasonPanelHtml(payload && payload.exit) +
        '</div>' +
        '</div>'
      );
    }

    function fmtClosedReasonCell(p, opts) {
      opts = opts || {};
      const entryPos = opts.entryPos || p;
      const exitPos = opts.exitPos || p;
      const openDetail = buildOpenEntryReasonDetail(entryPos);
      const exitDetail = buildClosedExitReasonDetail(exitPos, {
        partials: opts.partials,
        groupPartials: opts.groupPartials,
        isPartialSlice: opts.isPartialSlice === true,
      });
      const hasInfo = !!(openDetail && openDetail.hasInfo) || !!(exitDetail && exitDetail.hasInfo);
      const labelHtml =
        opts.labelHtml != null
          ? opts.labelHtml
          : fmtExitStyleHtml(exitPos && exitPos.reason);
      const payload = encodeURIComponent(
        JSON.stringify({
          dual: true,
          open: openDetail,
          exit: exitDetail,
        })
      );
      return (
        '<span class="pos-more-info closed-more-info" tabindex="0" role="button" ' +
        'aria-label="Open vs exit reason details" data-pos-more="' +
        escAttr(payload) +
        '" ' +
        'onmouseenter="showPosMoreInfo(this,event)" ' +
        'onfocus="showPosMoreInfo(this,event)" ' +
        'onclick="togglePosMoreInfo(this,event)" ' +
        'onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();togglePosMoreInfo(this,event);}">' +
        '<span class="closed-reason-main">' +
        labelHtml +
        '</span>' +
        '<span class="pos-more-info-label' +
        (hasInfo ? '' : ' is-empty') +
        '">More Info</span>' +
        '</span>'
      );
    }

    function fmtOpenReasonCell(p) {
      const detail = buildOpenEntryReasonDetail(p);
      const labelCls = detail.hasInfo ? '' : ' is-empty';
      const payload = encodeURIComponent(JSON.stringify(detail));
      return (
        '<span class="pos-more-info" tabindex="0" role="button" ' +
        'aria-label="More entry info" data-pos-more="' +
        escAttr(payload) +
        '" ' +
        'onmouseenter="showPosMoreInfo(this,event)" ' +
        'onfocus="showPosMoreInfo(this,event)" ' +
        'onclick="togglePosMoreInfo(this,event)" ' +
        'onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();togglePosMoreInfo(this,event);}">' +
        '<span class="pos-more-info-label' +
        labelCls +
        '">More Info</span>' +
        '</span>'
      );
    }

    function ensurePosMoreInfoFloat() {
      let el = document.getElementById('pos-more-info-float');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pos-more-info-float';
        el.setAttribute('role', 'tooltip');
        document.body.appendChild(el);
      }
      return el;
    }

    function placePosMoreInfoFloat(anchor, floatEl) {
      const rect = anchor.getBoundingClientRect();
      const pad = 8;
      floatEl.style.visibility = 'hidden';
      floatEl.classList.add('is-open');
      floatEl.setAttribute('aria-hidden', 'false');
      const fw = floatEl.offsetWidth || 280;
      const fh = floatEl.offsetHeight || 160;
      let left = rect.left;
      let top = rect.bottom + pad;
      if (left + fw > window.innerWidth - pad) {
        left = Math.max(pad, window.innerWidth - fw - pad);
      }
      if (top + fh > window.innerHeight - pad) {
        top = Math.max(pad, rect.top - fh - pad);
      }
      floatEl.style.left = left + 'px';
      floatEl.style.top = top + 'px';
      floatEl.style.visibility = 'visible';
    }

    function showPosMoreInfo(anchor, ev) {
      if (!anchor) return;
      const raw = anchor.getAttribute('data-pos-more') || '';
      let detail = null;
      try {
        detail = JSON.parse(decodeURIComponent(raw));
      } catch (_) {
        detail = { hasInfo: false };
      }
      const floatEl = ensurePosMoreInfoFloat();
      if (detail && detail.dual) {
        floatEl.classList.add('is-dual');
        floatEl.innerHTML = renderDualReasonPanelHtml(detail);
      } else {
        floatEl.classList.remove('is-dual');
        floatEl.innerHTML = renderOpenReasonPanelHtml(detail);
      }
      placePosMoreInfoFloat(anchor, floatEl);
      window._posMoreInfoAnchor = anchor;
    }

    function hidePosMoreInfo(force) {
      const floatEl = document.getElementById('pos-more-info-float');
      if (!floatEl) return;
      if (!force && floatEl.dataset.pinned === '1') return;
      floatEl.classList.remove('is-open');
      floatEl.classList.remove('is-dual');
      floatEl.setAttribute('aria-hidden', 'true');
      floatEl.dataset.pinned = '0';
      window._posMoreInfoAnchor = null;
    }

    function togglePosMoreInfo(anchor, ev) {
      if (ev) {
        ev.preventDefault();
        ev.stopPropagation();
      }
      const floatEl = ensurePosMoreInfoFloat();
      const open =
        floatEl.classList.contains('is-open') &&
        window._posMoreInfoAnchor === anchor &&
        floatEl.dataset.pinned === '1';
      if (open) {
        hidePosMoreInfo(true);
        return;
      }
      showPosMoreInfo(anchor, ev);
      floatEl.dataset.pinned = '1';
    }

    document.addEventListener(
      'mouseout',
      function (ev) {
        const floatEl = document.getElementById('pos-more-info-float');
        if (!floatEl || floatEl.dataset.pinned === '1') return;
        const to = ev.relatedTarget;
        if (
          to &&
          to.closest &&
          (to.closest('.pos-more-info') || to.closest('#pos-more-info-float'))
        ) {
          return;
        }
        const from = ev.target;
        if (
          from &&
          from.closest &&
          (from.closest('.pos-more-info') || from.closest('#pos-more-info-float'))
        ) {
          hidePosMoreInfo(false);
        }
      },
      true
    );

    document.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      if (t.closest('.pos-more-info') || t.closest('#pos-more-info-float')) return;
      hidePosMoreInfo(true);
    });

    window.showPosMoreInfo = showPosMoreInfo;
    window.togglePosMoreInfo = togglePosMoreInfo;
    window.hidePosMoreInfo = hidePosMoreInfo;

    function fmtOpenedHoldCell(openedAt) {
      const ts = Number(openedAt);
      if (!ts || !Number.isFinite(ts)) return '—';
      const entryLabel = new Date(ts).toLocaleString();
      const dur = fmtHold(Date.now() - ts);
      return '<div class="pos-hold" data-opened-at="' + ts + '" title="Opened ' + entryLabel +
        '" onclick="togglePosHoldEntry(this)" role="button" tabindex="0">' +
        '<div class="pos-hold-dur">' + dur + '</div>' +
        '<div class="pos-hold-entry">Opened ' + entryLabel + '</div>' +
        '</div>';
    }

    /** Compact relative age for Zion feed headers ("12s", "5m", "2h") — no "ago". */
    function fmtFoundAgoCompact(ts) {
      const t = Number(ts);
      if (!t || !Number.isFinite(t)) return '';
      const ms = Math.max(0, Date.now() - t);
      if (ms < 1000) return '0s';
      if (ms < 60_000) return Math.floor(ms / 1000) + 's';
      if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm';
      if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h';
      return Math.floor(ms / 86_400_000) + 'd';
    }

    function zionFoundAgoHtml(ts, titlePrefix) {
      const compact = fmtFoundAgoCompact(ts);
      if (!compact) return '';
      const t = Number(ts);
      const abs = new Date(t).toLocaleString();
      const tip = (titlePrefix ? titlePrefix + ' · ' : '') + abs;
      return (
        '<span class="zion-found-ago" title="' +
        escAttr(tip) +
        '">' +
        escHtml(compact) +
        '</span>'
      );
    }

    /** Relative "Xs/Xm/Xh/Xd ago" for event timestamps (migrations, signals, trades). */
    function fmtTimeAgo(ts) {
      const t = Number(ts);
      if (!t || !Number.isFinite(t)) return '—';
      const ms = Math.max(0, Date.now() - t);
      if (ms < 1000) return '0s ago';
      if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
      if (ms < 3_600_000) return Math.floor(ms / 60_000) + 'm ago';
      if (ms < 86_400_000) return Math.floor(ms / 3_600_000) + 'h ago';
      return Math.floor(ms / 86_400_000) + 'd ago';
    }

    /** Compact relative time with hover title (desktop) + tap-to-toggle absolute (mobile). */
    function fmtTimeAgoCell(ts) {
      const t = Number(ts);
      if (!t || !Number.isFinite(t)) return '—';
      const abs = new Date(t).toLocaleString();
      const tip = abs.replace(/"/g, '&quot;');
      return '<span class="pos-hold rel-time" data-event-at="' + t + '" title="' + tip +
        '" onclick="togglePosHoldEntry(this)" role="button" tabindex="0">' +
        '<span class="pos-hold-dur">' + fmtTimeAgo(t) + '</span>' +
        '<span class="pos-hold-entry">' + abs.replace(/</g, '&lt;') + '</span>' +
        '</span>';
    }

    function togglePosHoldEntry(el) {
      if (!el) return;
      // Desktop: native title tooltip; skip toggle on fine pointers
      if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        return;
      }
      el.classList.toggle('show-entry');
    }

    let _posHoldTimer = null;
    function tickOpenPositionHolds() {
      const overview = document.querySelector('[data-tab-panel="overview"]');
      const signals = document.querySelector('[data-tab-panel="signals"]');
      const trades = document.querySelector('[data-tab-panel="trades"]');
      const scanner = document.querySelector('[data-tab-panel="scanner"]');
      const overviewVisible = overview && !overview.classList.contains('hidden');
      const signalsVisible = signals && !signals.classList.contains('hidden');
      const tradesVisible = trades && !trades.classList.contains('hidden');
      const scannerVisible = scanner && !scanner.classList.contains('hidden');
      if (!overviewVisible && !signalsVisible && !tradesVisible && !scannerVisible) return;
      const now = Date.now();
      if (overviewVisible || tradesVisible) {
        document.querySelectorAll('.pos-hold[data-opened-at]').forEach((el) => {
          if (el.classList.contains('show-entry')) return;
          const opened = Number(el.getAttribute('data-opened-at'));
          if (!opened) return;
          const durEl = el.querySelector('.pos-hold-dur');
          if (durEl) durEl.textContent = fmtHold(now - opened);
        });
      }
      document.querySelectorAll('.pos-hold[data-event-at]').forEach((el) => {
        if (el.classList.contains('show-entry')) return;
        const at = Number(el.getAttribute('data-event-at'));
        if (!at) return;
        const durEl = el.querySelector('.pos-hold-dur');
        if (durEl) durEl.textContent = fmtTimeAgo(at);
      });
    }
    function ensurePosHoldTicker() {
      if (_posHoldTimer) return;
      _posHoldTimer = setInterval(tickOpenPositionHolds, 1000);
    }

    function fmtCopyDelay(ms) {
      if (ms == null || !Number.isFinite(Number(ms))) return '—';
      const v = Number(ms);
      if (v < 60_000) return Math.round(v / 1000) + 's';
      const m = Math.floor(v / 60_000);
      const s = Math.round((v % 60_000) / 1000);
      return s > 0 ? m + 'm ' + s + 's' : m + 'm';
    }

    function fmtWalletEntry(ts) {
      if (!ts) return '—';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function fmtPnlSolUsd(t) {
      const sol = Number(t.pnlSol || 0);
      const usd = t.pnlUsd != null
        ? Number(t.pnlUsd)
        : sol * Number(t.solUsd || 150);
      const color = sol >= 0 ? 'var(--green)' : 'var(--red)';
      const sign = sol >= 0 ? '+' : '';
      const rate = t.solUsd != null ? ' @ $' + Number(t.solUsd).toFixed(0) + '/SOL' : '';
      return '<div class="bt-pnl-cell" style="color:' + color + '" title="Cost ' +
        (t.costSol != null ? Number(t.costSol).toFixed(3) + ' SOL' : '—') + rate + '">' +
        '<div class="bt-pnl-sol">' + sign + sol.toFixed(4) + ' SOL</div>' +
        '<div class="bt-pnl-usd">' + sign + '$' + Math.abs(usd).toFixed(2) + '</div>' +
        '</div>';
    }

    /**
     * When exit reason quotes a mark ±X% (price vs entry), clarify vs fee-aware
     * realized pnlPct so green marks that print red after slip/fees aren't
     * mistaken for a WR counting bug.
     */
    function fmtMarkVsRealized(reason, pnlPct) {
      const m = String(reason || '').match(/\\bmark\\s*([+-]?\\d+(?:\\.\\d+)?)%/i);
      if (!m) return { chip: '', tip: '', inline: '' };
      const markPct = Number(m[1]);
      const real = Number(pnlPct || 0);
      if (!Number.isFinite(markPct)) return { chip: '', tip: '', inline: '' };
      const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
      const label = 'mark ' + fmt(markPct) + ' → realized ' + fmt(real);
      const tip =
        'Mark = price move vs entry at exit decision. Realized = fee+slip aware PnL % (row %). ' +
        label + '.';
      const chip =
        ' <span class="mint text-xs" style="opacity:.9;white-space:nowrap" title="' +
        tip.replace(/"/g, '&quot;') +
        '">' +
        label +
        '</span>';
      return { chip: chip, tip: tip, inline: chip };
    }

    function fmtExitTakes(t) {
      const takes = Array.isArray(t.exitTakes) ? t.exitTakes : [];
      const path = t.profitPath || '';
      if (!takes.length && !path) {
        return '<span class="mint">Full exit</span>';
      }
      const chipClass = (stage) => {
        if (stage === 'partial') return 'bt-chip-partial';
        if (stage === 'recover_initial') return 'bt-chip-initial';
        if (stage === 'bag_trim') return 'bt-chip-bag';
        if (stage === 'trail') return 'bt-chip-trail';
        if (stage === 'take_profit') return 'bt-chip-tp';
        if (stage === 'stop_loss') return 'bt-chip-sl';
        if (stage === 'forced') return 'bt-chip-forced';
        return 'bt-chip-other';
      };
      const short = (stage, label) => {
        if (stage === 'partial') return 'Partial';
        if (stage === 'recover_initial') return 'Initial✓';
        if (stage === 'bag_trim') return 'Bag';
        if (stage === 'trail') return 'Trail';
        if (stage === 'take_profit') return 'TP';
        if (stage === 'stop_loss') return 'SL';
        if (stage === 'forced') return 'Forced';
        return (label || 'Exit').slice(0, 12);
      };
      const chips = takes.map(function (take) {
        const tipParts = [take.label || take.stage];
        if (take.solOut != null) tipParts.push(Number(take.solOut).toFixed(4) + ' SOL out');
        if (take.pnlSol != null) tipParts.push((take.pnlSol >= 0 ? '+' : '') + Number(take.pnlSol).toFixed(4) + ' PnL');
        return '<span class="bt-chip ' + chipClass(take.stage) + '" title="' +
          tipParts.join(' · ').replace(/"/g, '&quot;') + '">' +
          short(take.stage, take.label) + '</span>';
      }).join('');
      const flags = [];
      if (t.recoveredInitial) flags.push('initial banked');
      if (t.partialTaken) flags.push('partial first');
      return '<div class="bt-takes">' + (chips || '<span class="mint">—</span>') + '</div>' +
        (path ? '<div class="bt-path" title="' + path.replace(/"/g, '&quot;') + '">' + path.replace(/</g, '&lt;') + '</div>' : '') +
        (flags.length ? '<div class="bt-path">' + flags.join(' · ') + '</div>' : '');
    }

    function ensureBacktestCharts() {
      if (typeof Chart === 'undefined') return;
      Chart.defaults.color = '#c9d1d9';
      Chart.defaults.borderColor = '#30363d';
      if (!chartBacktestPnl) {
        const canvas = document.getElementById('bt-chart-pnl');
        if (canvas) {
          chartBacktestPnl = new Chart(canvas, {
            type: 'line',
            data: {
              labels: [],
              datasets: [{
                label: 'Equity (SOL)',
                data: [],
                borderColor: '#34d399',
                backgroundColor: 'rgba(52,211,153,0.12)',
                fill: true,
                tension: 0.25,
                pointRadius: 3,
                pointHoverRadius: 6,
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  callbacks: {
                    afterBody: (items) => {
                      const i = items[0]?.dataIndex;
                      const pts =
                        window._lastBacktestCharts?.equityCurve?.points ||
                        window._lastBacktestCharts?.cumulativePnl?.points ||
                        [];
                      const p = pts[i];
                      if (!p) return [];
                      const lines = [];
                      if (p.symbol && p.symbol !== 'start') {
                        lines.push(p.symbol + ': ' + (p.pnlSol >= 0 ? '+' : '') + Number(p.pnlSol).toFixed(4) + ' SOL');
                      }
                      if (p.equity != null) lines.push('Equity ' + Number(p.equity).toFixed(4) + ' SOL');
                      return lines;
                    },
                  },
                },
              },
              scales: {
                x: { ticks: { maxTicksLimit: 8 } },
                y: { ticks: { callback: (v) => Number(v).toFixed(2) } },
              },
            },
          });
        }
      }
      if (!chartBacktestWl) {
        const canvas = document.getElementById('bt-chart-wl');
        if (canvas) {
          chartBacktestWl = new Chart(canvas, {
            type: 'bar',
            data: {
              labels: ['Wins', 'Losses'],
              datasets: [
                {
                  label: 'Count',
                  data: [0, 0],
                  backgroundColor: ['rgba(52,211,153,0.75)', 'rgba(248,113,113,0.75)'],
                  yAxisID: 'y',
                },
                {
                  label: 'Net SOL',
                  data: [0, 0],
                  backgroundColor: ['rgba(52,211,153,0.35)', 'rgba(248,113,113,0.35)'],
                  yAxisID: 'y1',
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { position: 'bottom' } },
              scales: {
                y: {
                  beginAtZero: true,
                  position: 'left',
                  ticks: { stepSize: 1 },
                  title: { display: true, text: 'Trades' },
                },
                y1: {
                  beginAtZero: true,
                  position: 'right',
                  grid: { drawOnChartArea: false },
                  title: { display: true, text: 'SOL' },
                },
              },
            },
          });
        }
      }
      if (!chartBacktestDist) {
        const canvas = document.getElementById('bt-chart-dist');
        if (canvas) {
          chartBacktestDist = new Chart(canvas, {
            type: 'bar',
            data: {
              labels: [],
              datasets: [{
                label: 'Trades',
                data: [],
                backgroundColor: 'rgba(96,165,250,0.65)',
              }],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } },
            },
          });
        }
      }
      if (!chartBacktestStrategy) {
        const canvas = document.getElementById('bt-chart-strategy');
        if (canvas) {
          chartBacktestStrategy = new Chart(canvas, {
            type: 'bar',
            data: {
              labels: ['migration', 'normal'],
              datasets: [
                {
                  label: 'PnL (SOL)',
                  data: [0, 0],
                  backgroundColor: 'rgba(52,211,153,0.7)',
                  yAxisID: 'y',
                },
                {
                  label: 'Win rate %',
                  data: [0, 0],
                  backgroundColor: 'rgba(96,165,250,0.55)',
                  yAxisID: 'y1',
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { position: 'bottom' } },
              scales: {
                y: { beginAtZero: true, position: 'left', title: { display: true, text: 'SOL' } },
                y1: {
                  beginAtZero: true,
                  max: 100,
                  position: 'right',
                  grid: { drawOnChartArea: false },
                  title: { display: true, text: 'Win %' },
                },
              },
            },
          });
        }
      }
      if (!chartBacktestRisk) {
        const canvas = document.getElementById('bt-chart-risk');
        if (canvas) {
          chartBacktestRisk = new Chart(canvas, {
            type: 'bar',
            data: {
              labels: ['on', 'off'],
              datasets: [
                {
                  label: 'PnL (SOL)',
                  data: [0, 0, 0, 0],
                  backgroundColor: 'rgba(52,211,153,0.7)',
                  yAxisID: 'y',
                },
                {
                  label: 'Win rate %',
                  data: [0, 0, 0, 0],
                  backgroundColor: 'rgba(96,165,250,0.55)',
                  yAxisID: 'y1',
                },
              ],
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { position: 'bottom' } },
              scales: {
                y: { beginAtZero: true, position: 'left', title: { display: true, text: 'SOL' } },
                y1: {
                  beginAtZero: true,
                  max: 100,
                  position: 'right',
                  grid: { drawOnChartArea: false },
                  title: { display: true, text: 'Win %' },
                },
              },
            },
          });
        }
      }
    }

    function updateBacktestCharts(charts) {
      ensureBacktestCharts();
      const empty = document.getElementById('bt-chart-empty');
      const emptyWl = document.getElementById('bt-chart-wl-empty');
      const emptyStrat = document.getElementById('bt-chart-strategy-empty');
      const emptyDist = document.getElementById('bt-chart-dist-empty');
      const emptyRisk = document.getElementById('bt-chart-risk-empty');

      const equity = charts && (charts.equityCurve || charts.cumulativePnl);
      if (chartBacktestPnl && equity && (equity.values || []).length) {
        if (empty) empty.style.display = 'none';
        chartBacktestPnl.data.labels = equity.labels || [];
        chartBacktestPnl.data.datasets[0].data = equity.values || [];
        chartBacktestPnl.data.datasets[0].label = charts.equityCurve
          ? 'Equity (SOL)'
          : 'Cumulative PnL (SOL)';
        chartBacktestPnl.update();
      } else if (empty) empty.style.display = '';

      if (chartBacktestWl && charts && charts.winLoss) {
        if (emptyWl) emptyWl.style.display = 'none';
        chartBacktestWl.data.datasets[0].data = charts.winLoss.counts || [0, 0];
        chartBacktestWl.data.datasets[1].data = charts.winLoss.pnlSol || [0, 0];
        chartBacktestWl.update();
      } else if (emptyWl) emptyWl.style.display = '';

      if (chartBacktestDist && charts && charts.pnlDistribution) {
        if (emptyDist) emptyDist.style.display = 'none';
        chartBacktestDist.data.labels = charts.pnlDistribution.labels || [];
        chartBacktestDist.data.datasets[0].data = charts.pnlDistribution.counts || [];
        chartBacktestDist.update();
      } else if (emptyDist) emptyDist.style.display = '';

      if (chartBacktestStrategy && charts && charts.strategyBreakdown) {
        const sb = charts.strategyBreakdown;
        if ((sb.labels || []).length) {
          if (emptyStrat) emptyStrat.style.display = 'none';
          chartBacktestStrategy.data.labels = sb.labels;
          chartBacktestStrategy.data.datasets[0].data = sb.pnlSol || [];
          chartBacktestStrategy.data.datasets[1].data = sb.winRatePct || [];
          chartBacktestStrategy.update();
        }
      } else if (emptyStrat) emptyStrat.style.display = '';

      if (chartBacktestRisk && charts && charts.riskComparison) {
        const rc = charts.riskComparison;
        if ((rc.labels || []).length) {
          if (emptyRisk) emptyRisk.style.display = 'none';
          chartBacktestRisk.data.labels = (rc.labels || []).map((l) => String(l).toUpperCase());
          chartBacktestRisk.data.datasets[0].data = rc.pnlSol || [];
          chartBacktestRisk.data.datasets[1].data = rc.winRatePct || [];
          chartBacktestRisk.update();
        }
      } else if (emptyRisk) emptyRisk.style.display = '';

      window._lastBacktestCharts = charts;
    }

    function setBtProgress(pct, label) {
      const wrap = document.getElementById('bt-progress-wrap');
      const bar = document.getElementById('bt-progress-bar');
      const lab = document.getElementById('bt-progress-label');
      const pctEl = document.getElementById('bt-progress-pct');
      if (wrap) wrap.classList.remove('hidden');
      if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
      if (lab) lab.textContent = label || '';
      if (pctEl) pctEl.textContent = Math.round(pct) + '%';
    }

    function hideBtProgress() {
      const wrap = document.getElementById('bt-progress-wrap');
      if (wrap) wrap.classList.add('hidden');
    }

    async function pollBacktestProgress() {
      try {
        const p = await fetchJSON('/backtest/progress');
        if (p && p.running) {
          setBtProgress(p.pct || 0, p.message || p.phase);
        } else if (p && p.phase === 'done') {
          setBtProgress(100, p.message || 'Done');
        }
      } catch (_) {}
    }

    function renderBacktestResult(data) {
      const status = document.getElementById('bt-status');
      const out = document.getElementById('bt-result');
      const sum = data.summary || {};
      const stats = data.stats || {};
      const cu = data.configUsed || {};
      if (status) {
        status.textContent =
          (data.dataSource || '—') + ' · ' + (data.tradesExecuted || 0) + ' trades' +
          (data.simulationsRun > 1 ? ' · ' + data.simulationsRun + ' sims' : '') +
          (sum.reBuyTrades ? ' · ' + sum.reBuyTrades + ' rebuys' : '') +
          (cu.riskLevel ? ' · risk ' + String(cu.riskLevel).toUpperCase() : '') +
          (cu.strictLabel ? ' · ' + cu.strictLabel : '');
      }
      if (out) {
        out.innerHTML =
          '<strong>' + (data.message || '') + '</strong><br/>' +
          'Period: ' + new Date(data.period.fromMs).toLocaleString() + ' → ' +
          new Date(data.period.toMs).toLocaleString() +
          ' (' + Number(data.period.hours).toFixed(1) + 'h)';
        if (data.aggregate) {
          out.innerHTML +=
            '<br/>Avg across sims: WR ' + data.aggregate.avgWinRatePct.toFixed(0) +
            '% · PnL ' + data.aggregate.avgNetPnlSol.toFixed(4) + ' SOL';
        }
      }
      const cfgUsedEl = document.getElementById('bt-config-used');
      if (cfgUsedEl) {
        if (cu.riskLevel) {
          cfgUsedEl.classList.remove('hidden');
          const strictTxt = cu.strictLabel
            ? String(cu.strictLabel)
            : 'Risk ' + String(cu.riskLevel || 'on').toUpperCase();
          const recipeTxt = cu.strategyRecipeMode === 'custom' ? 'recipe: custom' : 'recipe: synced';
          const profilesTxt = cu.tradeProfilesEnabled === false
            ? 'Multi-profile OFF'
            : ('Multi-profile ON · ' + Number(cu.tradeProfilesOnCount || 0) + ' active');
          cfgUsedEl.innerHTML =
            'Config used: <strong style="color:#e2e8f0">' + String(cu.riskLevel).toUpperCase() +
            (cu.label ? ' (' + cu.label + ')' : '') + '</strong>' +
            ' · <strong style="color:#e2e8f0">' + strictTxt + '</strong>' +
            ' · ' + recipeTxt +
            ' · ' + profilesTxt +
            (cu.effectiveMinConvictionScore != null
              ? ' · conviction≥' + cu.effectiveMinConvictionScore
              : '') +
            (cu.effectiveMinWalletQualityScore != null
              ? ' · Q≥' + cu.effectiveMinWalletQualityScore
              : '') +
            (cu.effectiveClusterMinWallets != null
              ? ' · cluster≥' + cu.effectiveClusterMinWallets
              : '') +
            (cu.minMarketCapUsd != null
              ? ' · min MC $' + Number(cu.minMarketCapUsd).toLocaleString()
              : '') +
            ' · base ' + Number(cu.baseTradeAmountSol || 0) + ' SOL' +
            ' · SL ' + Number(cu.stopLossPercent || 0) + '%' +
            ' · max profit ' + Number(cu.maxProfitPercent || 0) + '%' +
            ' · risk/trade ' + Number(cu.riskPercentPerTrade || 0) + '%' +
            ' · max DD ' + Number(cu.maxDrawdownPct || 0) + '%' +
            ' · fee ' + Number(cu.feeBps || 0) + 'bps / slip ' + Number(cu.slippageBps || 0) + 'bps' +
            (cu.profitStrategyEnabled
              ? ' · profit tiers (partial@' + Number(cu.partialSellAt || 0) + '% / trail@' + Number(cu.trailingStopAfter || 0) + '%)'
              : ' · profit strategy off') +
            (sum.forcedEndOfWindowTrades
              ? ' · EOW exits ' + sum.forcedEndOfWindowTrades
              : '');
        } else {
          cfgUsedEl.classList.add('hidden');
          cfgUsedEl.textContent = '';
        }
      }
      renderScoreCard('bt', data.performanceScore);
      refreshPerformanceCompare();
      const cmpWrap = document.getElementById('bt-risk-compare');
      const cmpBody = document.querySelector('#bt-risk-compare-table tbody');
      if (cmpWrap && cmpBody) {
        const rows = data.riskComparison || [];
        if (rows.length) {
          cmpWrap.classList.remove('hidden');
          cmpBody.innerHTML = rows.map(r => {
            const pnl = Number(r.totalPnlSol || 0);
            return '<tr>' +
              '<td><strong>' + String(r.riskLevel || '').toUpperCase() + '</strong></td>' +
              '<td>' + (r.tradesExecuted || 0) + '</td>' +
              '<td>' + Number(r.winRatePct || 0).toFixed(0) + '%</td>' +
              '<td style="color:' + (pnl >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
                (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + '</td>' +
              '<td>' + (r.profitFactor >= 999 ? '∞' : Number(r.profitFactor || 0).toFixed(2)) + '</td>' +
              '<td>' + Number(r.maxDrawdownPct || 0).toFixed(1) + '%</td>' +
              '<td>' + Number(r.sharpeRatio || 0).toFixed(2) + '</td>' +
              '<td>' + fmtHold(r.avgHoldMs) + '</td>' +
              '</tr>';
          }).join('');
        } else {
          cmpWrap.classList.add('hidden');
          cmpBody.innerHTML = '';
        }
      }
      const wr = document.getElementById('bt-stat-wr');
      if (wr) wr.textContent = (sum.winRatePct != null ? sum.winRatePct : stats.winRatePct || 0).toFixed(0) + '%';
      const wrSub = document.getElementById('bt-stat-wr-sub');
      if (wrSub) {
        const eowN = Number(sum.forcedEndOfWindowTrades || 0);
        wrSub.textContent =
          (sum.wins ?? 0) + 'W / ' + (sum.losses ?? 0) + 'L' +
          (eowN > 0 ? ' (excl. ' + eowN + ' EOW)' : '');
        if (eowN > 0 && sum.winRatePctAll != null) {
          wrSub.title =
            'Scored WR excludes end-of-window exits. All-trades WR (incl. EOW): ' +
            Number(sum.winRatePctAll).toFixed(0) + '%';
        } else {
          wrSub.title = 'Wins / losses on strategy exits (EOW excluded from WR)';
        }
      }
      const tradesEl = document.getElementById('bt-stat-trades');
      if (tradesEl) {
        tradesEl.textContent = String(sum.totalTrades ?? data.tradesExecuted ?? 0);
      }
      const tradesSub = document.getElementById('bt-stat-trades-sub');
      if (tradesSub) {
        tradesSub.textContent =
          (sum.reBuyTrades ? sum.reBuyTrades + ' rebuys · ' : '') +
          (data.simulationsRun > 1 ? data.simulationsRun + ' sims' : 'single run');
      }
      const wlrEl = document.getElementById('bt-stat-wlr');
      if (wlrEl) {
        const wlr = sum.winLossRatio != null
          ? sum.winLossRatio
          : (sum.losses > 0 ? sum.wins / sum.losses : (sum.wins > 0 ? 999 : 0));
        wlrEl.textContent = wlr >= 999 ? '∞' : Number(wlr).toFixed(2);
        wlrEl.style.color = wlr >= 1.5 ? 'var(--green)' : wlr >= 1 ? 'var(--muted)' : 'var(--red)';
      }
      const wlCounts = document.getElementById('bt-stat-wl-counts');
      if (wlCounts) {
        const eowN = Number(sum.forcedEndOfWindowTrades || 0);
        wlCounts.textContent =
          (sum.wins ?? 0) + ' wins · ' + (sum.losses ?? 0) + ' losses' +
          (eowN > 0 ? ' (excl. ' + eowN + ' EOW)' : '');
      }
      const pfEl = document.getElementById('bt-stat-pf');
      if (pfEl) {
        const pf = sum.profitFactor != null ? sum.profitFactor : (stats.profitFactor || 0);
        pfEl.textContent = pf >= 999 ? '∞' : Number(pf).toFixed(2);
        pfEl.style.color = pf >= 1.5 ? 'var(--green)' : pf >= 1 ? 'var(--muted)' : 'var(--red)';
      }
      const expectEl = document.getElementById('bt-stat-expect');
      if (expectEl && sum.expectancySol != null) {
        expectEl.textContent = 'Expectancy ' + (sum.expectancySol >= 0 ? '+' : '') + Number(sum.expectancySol).toFixed(4) + ' SOL';
      }
      const pnl = document.getElementById('bt-stat-pnl');
      if (pnl) {
        const n = sum.totalPnlSol != null ? sum.totalPnlSol : stats.netPnlSol || 0;
        const usd = sum.totalPnlUsd != null
          ? sum.totalPnlUsd
          : n * Number(sum.solUsd || 150);
        const rate = sum.solUsd != null ? sum.solUsd : null;
        const ret = sum.returnPct != null ? Number(sum.returnPct).toFixed(1) + '%' : '';
        pnl.innerHTML =
          '<div>' + (n >= 0 ? '+' : '') + Number(n).toFixed(4) + ' SOL</div>' +
          '<div style="font-size:12px;opacity:.85">' + (usd >= 0 ? '+' : '') + '$' + Math.abs(Number(usd)).toFixed(2) +
          (rate != null ? ' <span class="mint">@ $' + Number(rate).toFixed(0) + '</span>' : '') +
          (ret ? ' · ' + ret : '') +
          '</div>';
        pnl.style.color = n >= 0 ? 'var(--green)' : 'var(--red)';
      }
      const retEl = document.getElementById('bt-stat-return');
      if (retEl) {
        const r = sum.returnPct != null ? Number(sum.returnPct) : 0;
        retEl.textContent = (r >= 0 ? '+' : '') + r.toFixed(1) + '%';
        retEl.style.color = r >= 0 ? 'var(--green)' : 'var(--red)';
      }
      const riskUsed = document.getElementById('bt-stat-risk-used');
      if (riskUsed) {
        riskUsed.textContent = cu.riskLevel
          ? 'risk ' + String(cu.riskLevel).toUpperCase() + (cu.label ? ' · ' + cu.label : '')
          : 'risk —';
      }
      const sharpe = document.getElementById('bt-stat-sharpe');
      if (sharpe) {
        const s = sum.sharpeRatio != null ? Number(sum.sharpeRatio) : 0;
        sharpe.textContent = s.toFixed(2);
        sharpe.style.color = s >= 1 ? 'var(--green)' : s >= 0 ? 'var(--muted)' : 'var(--red)';
      }
      const maxDd = document.getElementById('bt-stat-maxdd');
      if (maxDd) {
        const m = sum.maxDrawdownPct != null ? Number(sum.maxDrawdownPct) : (stats.maxDrawdownPct || 0);
        maxDd.textContent = m.toFixed(1) + '%';
        maxDd.style.color = m <= 15 ? 'var(--green)' : m <= 30 ? 'var(--muted)' : 'var(--red)';
      }
      const avg = document.getElementById('bt-stat-avg');
      if (avg) {
        avg.innerHTML =
          '<span style="color:var(--green)">+' + Number(sum.avgWinPct || 0).toFixed(0) + '%</span> / ' +
          '<span style="color:var(--red)">' + Number(sum.avgLossPct || 0).toFixed(0) + '%</span>';
      }
      const avgSol = document.getElementById('bt-stat-avg-sol');
      if (avgSol) {
        avgSol.innerHTML =
          '<span style="color:var(--green)">+' + Number(sum.avgWinSol || 0).toFixed(4) + '</span> / ' +
          '<span style="color:var(--red)">' + Number(sum.avgLossSol || 0).toFixed(4) + '</span> SOL';
      }
      const bw = document.getElementById('bt-stat-bw');
      if (bw) {
        const best = sum.bestTrade;
        const worst = sum.worstTrade;
        bw.innerHTML =
          (best ? '<span style="color:var(--green)">' + best.symbol + ' ' + (best.pnlPct >= 0 ? '+' : '') + best.pnlPct.toFixed(0) + '%</span>' : '—') +
          ' / ' +
          (worst ? '<span style="color:var(--red)">' + worst.symbol + ' ' + worst.pnlPct.toFixed(0) + '%</span>' : '—');
      }
      const hold = document.getElementById('bt-stat-hold');
      if (hold) hold.textContent = fmtHold(sum.avgHoldingMs);
      const dd = document.getElementById('bt-stat-dd');
      if (dd) {
        dd.textContent = 'avg trade DD ' + (sum.avgMaxDrawdownPct != null ? Number(sum.avgMaxDrawdownPct).toFixed(1) : '0') + '%';
      }
      const costEl = document.getElementById('bt-stat-cost');
      if (costEl) {
        costEl.textContent = sum.avgRoundTripCostBps != null
          ? 'RT cost ~' + Number(sum.avgRoundTripCostBps).toFixed(0) + ' bps'
          : 'RT cost —';
      }

      const stratBody = document.querySelector('#bt-strategy-table tbody');
      if (stratBody) {
        const rows = sum.strategyBreakdown || [];
        stratBody.innerHTML = rows.length === 0
          ? '<tr><td colspan="10" class="text-slate-500">No strategy breakdown</td></tr>'
          : rows.map(r => {
              const wl =
                r.losses > 0
                  ? (r.wins / r.losses).toFixed(2)
                  : r.wins > 0
                    ? '∞'
                    : '0';
              return \`
            <tr>
              <td><strong>\${r.strategyKind}</strong></td>
              <td>\${r.trades}</td>
              <td>\${Number(r.winRatePct || 0).toFixed(0)}%</td>
              <td>\${r.wins || 0} / \${r.losses || 0} (\${wl})</td>
              <td style="color:\${r.totalPnlSol >= 0 ? 'var(--green)' : 'var(--red)'}">\${r.totalPnlSol >= 0 ? '+' : ''}\${Number(r.totalPnlSol).toFixed(4)}</td>
              <td>\${r.profitFactor >= 999 ? '∞' : Number(r.profitFactor).toFixed(2)}</td>
              <td style="color:var(--green)">+\${Number(r.avgWinPct || 0).toFixed(0)}%</td>
              <td style="color:var(--red)">\${Number(r.avgLossPct || 0).toFixed(0)}%</td>
              <td>\${Number(r.maxDrawdownPct || 0).toFixed(1)}%</td>
              <td>\${fmtHold(r.avgHoldMs)}</td>
            </tr>\`;
            }).join('');
      }

      const profileBody = document.querySelector('#bt-profile-table tbody');
      if (profileBody) {
        const rows = sum.profileBreakdown || [];
        profileBody.innerHTML = rows.length === 0
          ? '<tr><td colspan="6" class="text-slate-500">No profile breakdown</td></tr>'
          : rows.map(r => {
              const badge = fmtTradeProfileBadge({
                tradeProfileId: r.profileId,
                tradeProfileName: r.name,
                tradeProfileIcon: r.icon,
                tradeProfileColor: r.color,
              }, { hideScore: true });
              const pnl = Number(r.totalPnlSol || 0);
              return '<tr>' +
                '<td>' + badge + '</td>' +
                '<td>' + (r.trades || 0) + '</td>' +
                '<td>' + Number(r.winRatePct || 0).toFixed(0) + '%</td>' +
                '<td>' + (r.wins || 0) + ' / ' + (r.losses || 0) + '</td>' +
                '<td style="color:' + (pnl >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
                  (pnl >= 0 ? '+' : '') + pnl.toFixed(4) + '</td>' +
                '<td style="color:' + (Number(r.avgPnlPct || 0) >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
                  (Number(r.avgPnlPct || 0) >= 0 ? '+' : '') + Number(r.avgPnlPct || 0).toFixed(1) + '%</td>' +
                '</tr>';
            }).join('');
      }

      const tbody = document.querySelector('#bt-results-table tbody');
      const trades = data.trades || [];
      if (tbody) {
        tbody.innerHTML = trades.length === 0
          ? '<tr><td colspan="16" style="color:var(--muted)">No trades in this run</td></tr>'
          : trades.map(t => {
              const pct = Number(t.pnlPct || 0);
              const sol = Number(t.pnlSol || 0);
              const color = pct >= 0 ? 'var(--green)' : 'var(--red)';
              const rowClass = sol > 0 ? 'bt-row-win' : (sol < 0 ? 'bt-row-loss' : '');
              const walletTs = t.smartWalletEnteredAt || t.launchedAt || t.openedAt;
              const walletMc = t.smartWalletEntryMarketCapUsd != null
                ? t.smartWalletEntryMarketCapUsd
                : t.entryMarketCapUsd != null ? t.entryMarketCapUsd : t.marketCapUsd;
              const yourMc = t.entryMarketCapUsd != null ? t.entryMarketCapUsd : t.marketCapUsd;
              const exitMc = t.exitMarketCapUsd != null ? t.exitMarketCapUsd : null;
              const liq = t.liquidityUsd;
              const reason = t.reason || '—';
              const debugLines = (t.debugLog || []).join('\\n');
              const markVsReal = fmtMarkVsRealized(reason, pct);
              const reasonTip = (t.reasonDetail || reason).replace(/"/g, '&quot;') +
                (markVsReal.tip ? '\\n\\n' + markVsReal.tip.replace(/"/g, '&quot;') : '') +
                (debugLines ? '\\n\\n— Debug —\\n' + debugLines.replace(/"/g, '&quot;') : '');
              const scalpChip = t.shortTermStrategyId
                ? ' <span class="mint text-xs" style="opacity:.85" title="Scalp engine">' +
                  String(t.shortTermStrategyId).replace(/_/g, ' ') + '</span>'
                : '';
              const eowChip = t.forcedEndOfWindow
                ? ' <span class="mint text-xs" title="Forced mark-to-market at end of lookback">EOW</span>'
                : '';
              return '<tr class="' + rowClass + '">' +
                '<td>' + fmtBacktestToken(t.symbol, t.name, t.mint) +
                (t.migrated ? ' 🚀' : t.isPumpFun ? ' 🎯' : '') +
                (t.isReBuy ? ' <span class="mint">rebuy</span>' : '') + eowChip + '</td>' +
                '<td>' + fmtTradeProfileBadge(t) + scalpChip + '</td>' +
                '<td style="color:' + color + ';font-weight:700" title="' +
                  (markVsReal.tip ? markVsReal.tip.replace(/"/g, '&quot;') : 'Fee-aware realized PnL % vs cost') +
                '">' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</td>' +
                '<td>' + fmtPnlSolUsd(t) + '</td>' +
                '<td>' + fmtExitTakes(t) + '</td>' +
                '<td class="mint" title="Smart wallet entry MC">' + fmtUsdShort(walletMc) + '</td>' +
                '<td class="mint bt-your-mc" title="Your copy fill MC">' + fmtUsdShort(yourMc) + '</td>' +
                '<td class="mint" title="Exit MC scaled from Dex snapshot (path multiple capped)">' + fmtUsdShort(exitMc) + '</td>' +
                '<td class="mint" title="Copy delay after smart wallet">' + fmtCopyDelay(t.copyDelayMs) + '</td>' +
                '<td class="mint">' + fmtHold(t.holdingTimeMs) + '</td>' +
                '<td style="color:var(--red)">' + Number(t.maxDrawdownPct || 0).toFixed(1) + '%</td>' +
                '<td class="mint" title="' +
                  (t.smartWalletLiquidityUsd != null
                    ? 'Wallet liq ~' + fmtUsdShort(t.smartWalletLiquidityUsd) + ' · Your entry liq'
                    : 'Liquidity at your entry') +
                '">' + fmtUsdShort(liq) + '</td>' +
                '<td class="mint">' + (t.riskScoreHint != null ? t.riskScoreHint : '—') + '</td>' +
                '<td class="mint">' + fmtEntrySourceBadge(t) + ' ' +
                (t.smartWalletCount != null ? t.smartWalletCount : (t.sourceNames || []).length) +
                ((t.sourceNames || []).length ? ' (' + t.sourceNames.slice(0, 2).join(', ') + ')' : '') + '</td>' +
                '<td class="mint" title="' + reasonTip + '">' + reason.replace(/</g, '&lt;') +
                (markVsReal.inline || '') +
                ((t.debugLog || []).length ? ' <span style="opacity:.6">(' + t.debugLog.length + ' steps)</span>' : '') +
                '</td>' +
                '<td class="mint" title="Smart wallet entry">' + fmtWalletEntry(walletTs) + '</td>' +
                '</tr>';
            }).join('');
      }
      const dbg = document.getElementById('bt-debug-log');
      if (dbg) {
        const allLines = [];
        for (const t of trades) {
          const lines = t.debugLog || [];
          if (!lines.length) continue;
          allLines.push('── ' + (t.symbol || t.mint) + ' · ' + (t.pnlPct >= 0 ? '+' : '') + Number(t.pnlPct || 0).toFixed(1) + '% ──');
          for (const line of lines) allLines.push(line);
          allLines.push('');
        }
        dbg.textContent = allLines.length
          ? allLines.join('\\n')
          : 'No exit debug lines for this run.';
      }
      if (data.charts) updateBacktestCharts(data.charts);
      window._lastBacktest = data;
    }

    function jupiterTokenUrl(mint) {
      return 'https://jup.ag/tokens/' + encodeURIComponent(String(mint || '').trim());
    }

    function escAttr(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function escHtml(s) {
      return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    /** Compact smart-wallet address + Copy (same clipboard pattern as Copy CA) */
    function fmtWalletAddr(address) {
      const addr = String(address || '').trim();
      if (!addr) return '<span class="mint">—</span>';
      const attr = escAttr(addr);
      const short = escHtml(addr.slice(0, 8) + '…' + addr.slice(-4));
      return '<span class="wallet-addr">' +
        '<span class="mint" title="' + attr + '">' + short + '</span>' +
        '<button type="button" class="ca-btn" data-addr="' + attr +
          '" onclick="copyWalletAddress(event)" title="Copy wallet address">Copy</button>' +
        '</span>';
    }

    async function copyWalletAddress(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const el = ev && (ev.currentTarget || ev.target);
      const host = el && el.closest
        ? (el.closest('[data-addr]') || el)
        : el;
      const addr = host && host.getAttribute
        ? String(host.getAttribute('data-addr') || '').trim()
        : '';
      if (!addr) return;
      const ok = await copyTextToClipboard(addr);
      const btn = el && el.closest ? el.closest('.ca-btn') : el;
      if (ok && btn) {
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = prev || 'Copy';
          btn.classList.remove('copied');
        }, 1400);
      }
      const st =
        document.getElementById('search-status') ||
        document.getElementById('discover-status') ||
        document.getElementById('top-status') ||
        document.getElementById('gmgn-status');
      if (st) {
        st.textContent = (ok ? 'Copied: ' : 'Copy failed: ') +
          addr.slice(0, 8) + '…' + addr.slice(-4);
      }
      if (!ok) alert('Could not copy: ' + addr);
    }

    /** Token ticker: native title tip + click to copy CA (Copy/Jupiter live in Mint col) */
    function fmtTokenCa(symbol, name, mint) {
      const tick = (symbol || (mint ? String(mint).slice(0, 6) : '?')).trim();
      const label = escHtml(tick);
      const ca = String(mint || '').trim();
      if (!ca) return '<strong>' + label + '</strong>';
      const attr = escAttr(ca);
      return '<span class="token-ca" tabindex="0" role="button" data-mint="' + attr +
        '" title="' + attr + ' — click to copy CA" onclick="copyContractAddress(event)">' +
        '<strong>' + label + '</strong></span>';
    }

    /** Compact mint column: short CA + Copy + Jupiter */
    function fmtMintCa(mint) {
      const ca = String(mint || '').trim();
      if (!ca) return '<span class="mint">—</span>';
      const attr = escAttr(ca);
      const short = escHtml(ca.slice(0, 8) + '…' + ca.slice(-4));
      const jup = escAttr(jupiterTokenUrl(ca));
      return '<span class="mint-ca">' +
        '<span class="token-ca" tabindex="0" role="button" data-mint="' + attr +
          '" title="' + attr + ' — click to copy" onclick="copyContractAddress(event)">' + short + '</span>' +
        '<button type="button" class="ca-btn" data-mint="' + attr + '" onclick="copyMintFromEl(event)" title="Copy contract address">Copy</button>' +
        '<a class="ca-btn ca-jup" href="' + jup + '" target="_blank" rel="noopener noreferrer" title="Open on Jupiter">Jupiter</a>' +
      '</span>';
    }

    function fmtBacktestToken(symbol, name, mint) {
      return fmtTokenCa(symbol, name, mint);
    }

    async function copyTextToClipboard(text) {
      const ca = String(text || '').trim();
      if (!ca) return false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(ca);
        } else {
          const ta = document.createElement('textarea');
          ta.value = ca;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        return true;
      } catch (err) {
        return false;
      }
    }

    function flashCopiedCa(host) {
      if (!host) return;
      host.classList.add('copied');
      const prevTitle = host.getAttribute('title');
      host.setAttribute('title', 'Copied!');
      setTimeout(() => {
        host.classList.remove('copied');
        if (prevTitle != null) host.setAttribute('title', prevTitle);
      }, 1400);
    }

    async function copyMintFromEl(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const el = ev && (ev.currentTarget || ev.target);
      const host = el && el.closest
        ? (el.closest('[data-mint]') || el)
        : el;
      const ca = host && host.getAttribute
        ? String(host.getAttribute('data-mint') || '').trim()
        : '';
      if (!ca) return;
      const ok = await copyTextToClipboard(ca);
      const tokenHost = el && el.closest ? el.closest('.token-ca') : null;
      if (ok) flashCopiedCa(tokenHost || (host && host.classList && host.classList.contains('token-ca') ? host : null));
      if (ok && el && el.classList && el.classList.contains('ca-btn')) {
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1400);
      }
      const st = document.getElementById('bt-status');
      if (st) st.textContent = (ok ? 'Copied CA: ' : 'Copy failed: ') + ca.slice(0, 8) + '…' + ca.slice(-4);
      if (!ok) alert('Could not copy: ' + ca);
    }

    async function copyContractAddress(ev) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      const el = ev && (ev.currentTarget || ev.target);
      const host = el && el.closest ? el.closest('.token-ca') : el;
      const ca = host && host.getAttribute ? String(host.getAttribute('data-mint') || '').trim() : '';
      if (!ca) return;
      const ok = await copyTextToClipboard(ca);
      if (ok) flashCopiedCa(host);
      const st = document.getElementById('bt-status');
      if (st) st.textContent = (ok ? 'Copied CA: ' : 'Copy failed: ') + ca.slice(0, 8) + '…' + ca.slice(-4);
      if (!ok) alert('Could not copy: ' + ca);
    }

    async function runBacktest(extraOpts) {
      const status = document.getElementById('bt-status');
      const out = document.getElementById('bt-result');
      const btn = document.getElementById('bt-run-btn');
      if (status) status.textContent = 'Running…';
      if (out) out.textContent = '';
      if (btn) btn.disabled = true;
      setBtProgress(2, 'Starting simulation…');
      clearInterval(_btProgressTimer);
      _btProgressTimer = setInterval(pollBacktestProgress, 400);
      try {
        const strict = typeof btStrictPayload === 'function' ? btStrictPayload() : {};
        const data = await fetchJSON('/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({
            hours: Number(document.getElementById('bt-hours').value),
            maxTrades: Number(document.getElementById('bt-max').value),
            simulations: Number((document.getElementById('bt-sims') || {}).value) || 1,
            startingBalanceSol: Number((document.getElementById('bt-start-bal') || {}).value) || undefined,
            strategyType: (document.getElementById('bt-strategy') || {}).value || 'auto',
            riskLevel: (document.getElementById('bt-risk-level') || {}).value || 'current',
            compareRiskLevels: !!(document.getElementById('bt-compare-risk') || {}).checked,
            useSavedConfigFilters: true,
            parityMode: true,
            minLiquidityUsd: Number((document.getElementById('bt-min-liq') || {}).value) || 0,
            minMarketCapUsd: Number((document.getElementById('bt-min-mc') || {}).value) || 0,
            minVolumeUsd: Number((document.getElementById('bt-min-vol') || {}).value) || 0,
            maxRiskScore: Number((document.getElementById('bt-max-risk') || {}).value) || 0,
            minConvictionScore: Number((document.getElementById('bt-min-conviction') || {}).value) || 0,
            minWalletQualityScore: Number((document.getElementById('bt-min-wallet-q') || {}).value) || 0,
            useLiveData: document.getElementById('bt-live').checked,
            migrationsOnly: document.getElementById('bt-mig-only').checked,
            pumpFunOnly: (document.getElementById('bt-pump-only') || {}).checked,
            reBuyEnabled: (document.getElementById('bt-rebuy') || {}).checked,
            allowSynthetic: !!(document.getElementById('bt-synthetic') || {}).checked,
          }, strict, extraOpts || {})),
          timeoutMs: 180000,
        });
        setBtProgress(100, 'Complete');
        renderBacktestResult(data);
        showTab('backtester');
        setTimeout(hideBtProgress, 1500);
      } catch (err) {
        if (status) status.textContent = err.message;
        hideBtProgress();
      } finally {
        clearInterval(_btProgressTimer);
        if (btn) btn.disabled = false;
      }
    }

    async function loadLastBacktest() {
      const status = document.getElementById('bt-status');
      try {
        const data = await fetchJSON('/backtest/last');
        renderBacktestResult(data);
        if (status) status.textContent = 'Loaded last run · ' + (data.dataSource || '');
        try { loadLastOptimizerResult(); } catch (_) {}
      } catch (err) {
        if (status) status.textContent = err.message || 'No saved backtest';
      }
    }

    function exportBacktestCsv() {
      if (!window._lastBacktest || !(window._lastBacktest.trades || []).length) {
        alert('Run a backtest first');
        return;
      }
      window.location.href = '/backtest/export.csv';
    }

    function exportBacktestJson() {
      if (!window._lastBacktest || !(window._lastBacktest.trades || []).length) {
        alert('Run a backtest first');
        return;
      }
      window.location.href = '/backtest/export.json';
    }

    function selectedAdvisorIds() {
      return Array.from(document.querySelectorAll('#bt-advisor-table input.bt-advisor-check:checked'))
        .map(function (el) { return el.getAttribute('data-id'); })
        .filter(Boolean);
    }

    function fmtAdvisorDelta(n, suffix) {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      const v = Number(n);
      const sign = v > 0 ? '+' : '';
      return sign + v.toFixed(suffix === 'SOL' ? 4 : 2) + (suffix === '%' ? '%' : suffix === 'SOL' ? '' : '');
    }

    function renderAdvisorReport(advisor, compare) {
      const status = document.getElementById('bt-advisor-status');
      const evidence = document.getElementById('bt-advisor-evidence');
      const compareEl = document.getElementById('bt-advisor-compare');
      const tbody = document.querySelector('#bt-advisor-table tbody');
      const disc = document.getElementById('bt-advisor-disclaimer');
      if (disc && advisor && advisor.disclaimer) disc.textContent = advisor.disclaimer;
      if (!advisor) {
        if (status) status.textContent = 'No advisor report';
        return;
      }
      window._lastAdvisor = advisor;
      if (status) {
        status.textContent =
          advisor.loserCount + ' losers · ' + advisor.skipCount + ' skips · ' +
          (advisor.recommendations || []).length + ' tips' +
          (advisor.eowCount ? ' · ' + advisor.eowCount + ' EOW' : '');
      }
      if (evidence) {
        const loseBits = (advisor.loserClusters || []).slice(0, 4).map(function (c) {
          return c.label + '×' + c.count;
        }).join(', ');
        const skipBits = (advisor.skipClusters || []).slice(0, 3).map(function (c) {
          return c.label + '×' + c.count;
        }).join(', ');
        evidence.classList.remove('hidden');
        evidence.innerHTML =
          (loseBits ? '<strong style="color:#e2e8f0">Loser clusters:</strong> ' + loseBits : '') +
          (skipBits ? (loseBits ? ' · ' : '') + '<strong style="color:#e2e8f0">Skips:</strong> ' + skipBits : '') ||
          'No clusters';
      }
      if (compareEl) {
        if (compare && compare.delta) {
          compareEl.classList.remove('hidden');
          const d = compare.delta;
          compareEl.innerHTML =
            '<strong style="color:#e2e8f0">Re-run vs baseline:</strong> ΔWR ' +
            fmtAdvisorDelta(d.winRatePct, '%') +
            ' · ΔPF ' + fmtAdvisorDelta(d.profitFactor, '') +
            ' · ΔPnL ' + fmtAdvisorDelta(d.totalPnlSol, 'SOL') + ' SOL' +
            ' · Δtrades ' + fmtAdvisorDelta(d.trades, '');
        } else {
          compareEl.classList.add('hidden');
          compareEl.textContent = '';
        }
      }
      if (tbody) {
        const rows = advisor.recommendations || [];
        tbody.innerHTML = rows.length === 0
          ? '<tr><td colspan="7" class="text-slate-500">No recommendations for this run</td></tr>'
          : rows.map(function (r) {
              const keep = r.keep === true;
              const scored = r.scored === true;
              const deltaColor = function (v) {
                if (v == null) return 'var(--muted)';
                return Number(v) >= 0 ? 'var(--green)' : 'var(--red)';
              };
              return '<tr>' +
                '<td><input type="checkbox" class="bt-advisor-check" data-id="' + escAttr(r.id) + '"' +
                  (keep ? ' checked' : '') + ' /></td>' +
                '<td><strong style="color:#e2e8f0">' + escHtml(r.title) + '</strong>' +
                  '<div class="mint text-xs mt-0.5">' + escHtml(r.rationale || '') +
                  (r.scoreNote ? ' · ' + escHtml(r.scoreNote) : '') + '</div>' +
                  (r.detailTips && r.detailTips.length
                    ? '<ul class="mint text-xs mt-1" style="margin:0;padding-left:1.1rem;opacity:0.9">' +
                      r.detailTips.map(function (tip) {
                        return '<li>' + escHtml(tip) + '</li>';
                      }).join('') +
                      '</ul>'
                    : '') +
                  '</td>' +
                '<td class="mint">' + (r.evidenceCount || 0) + '</td>' +
                '<td style="color:' + deltaColor(r.deltaWinRatePct) + '">' +
                  (scored ? fmtAdvisorDelta(r.deltaWinRatePct, '%') : '—') + '</td>' +
                '<td style="color:' + deltaColor(r.deltaProfitFactor) + '">' +
                  (scored ? fmtAdvisorDelta(r.deltaProfitFactor, '') : '—') + '</td>' +
                '<td style="color:' + deltaColor(r.deltaPnlSol) + '">' +
                  (scored ? fmtAdvisorDelta(r.deltaPnlSol, 'SOL') : '—') + '</td>' +
                '<td class="mint">' + (scored ? (keep ? 'Yes' : 'No') : 'pending') + '</td>' +
                '</tr>';
            }).join('');
      }
    }

    async function analyzeBacktestAdvisor() {
      const status = document.getElementById('bt-advisor-status');
      const btn = document.getElementById('bt-advisor-analyze-btn');
      if (!window._lastBacktest || !(window._lastBacktest.trades || []).length) {
        alert('Run a backtest first');
        return;
      }
      if (status) status.textContent = 'Analyzing & scoring (shadow re-runs)…';
      if (btn) btn.disabled = true;
      setBtProgress(5, 'Advisor scoring…');
      clearInterval(_btProgressTimer);
      _btProgressTimer = setInterval(pollBacktestProgress, 400);
      try {
        const data = await fetchJSON('/backtest/advise', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score: true, maxScore: 6 }),
          timeoutMs: 300000,
        });
        renderAdvisorReport(data.advisor);
        setBtProgress(100, 'Advisor complete');
        setTimeout(hideBtProgress, 1200);
      } catch (err) {
        if (status) status.textContent = err.message || 'Advisor failed';
        hideBtProgress();
      } finally {
        clearInterval(_btProgressTimer);
        if (btn) btn.disabled = false;
      }
    }

    async function rerunBacktestWithAdvisor() {
      const ids = selectedAdvisorIds();
      if (!ids.length) {
        alert('Check at least one recommendation');
        return;
      }
      const status = document.getElementById('bt-advisor-status');
      const btn = document.getElementById('bt-advisor-rerun-btn');
      if (status) status.textContent = 'Re-running with selected tips…';
      if (btn) btn.disabled = true;
      setBtProgress(5, 'Advisor re-run…');
      clearInterval(_btProgressTimer);
      _btProgressTimer = setInterval(pollBacktestProgress, 400);
      try {
        const data = await fetchJSON('/backtest/advise/rerun', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recommendationIds: ids }),
          timeoutMs: 180000,
        });
        if (data.result) {
          renderBacktestResult(data.result);
        }
        renderAdvisorReport(data.advisor || window._lastAdvisor || { recommendations: [] }, data.comparison);
        if (data.comparison) {
          const st = document.getElementById('bt-advisor-status');
          if (st) {
            st.textContent =
              'Re-run applied ' + ids.length + ' tip(s) · ΔPnL ' +
              fmtAdvisorDelta(data.comparison.delta && data.comparison.delta.totalPnlSol, 'SOL') + ' SOL';
          }
        }
        setBtProgress(100, 'Re-run complete');
        setTimeout(hideBtProgress, 1200);
      } catch (err) {
        if (status) status.textContent = err.message || 'Re-run failed';
        hideBtProgress();
      } finally {
        clearInterval(_btProgressTimer);
        if (btn) btn.disabled = false;
      }
    }

    async function applyAdvisorToLive() {
      const ids = selectedAdvisorIds();
      if (!ids.length) {
        alert('Check at least one recommendation');
        return;
      }
      if (!confirm(
        'Apply ' + ids.length + ' recommendation(s) to live Settings / filters / Trade Profiles?\\n\\n' +
        'This persists settings. You can undo by toggling modules back on the Settings tab.'
      )) {
        return;
      }
      const status = document.getElementById('bt-advisor-status');
      try {
        const data = await fetchJSON('/backtest/advise/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recommendationIds: ids }),
        });
        if (status) status.textContent = data.message || 'Applied to live';
        if (typeof loadStrategies === 'function') {
          try { loadStrategies(); } catch (_) {}
        }
        if (typeof refreshAll === 'function') {
          try { refreshAll(); } catch (_) {}
        }
      } catch (err) {
        if (status) status.textContent = err.message || 'Apply failed';
        alert(err.message || 'Apply failed');
      }
    }

    let _optProgressTimer = null;
    window._lastOptimizer = null;

    function selectedOptimizerRisks() {
      const risks = [];
      if (document.getElementById('bt-opt-on')?.checked) risks.push('on');
      return risks;
    }

    function selectedOptimizerCandidateIds() {
      return Array.from(document.querySelectorAll('.bt-opt-pick:checked')).map(function (el) {
        return { riskLevel: el.getAttribute('data-risk'), candidateId: el.value };
      });
    }

    async function pollOptimizerProgress() {
      try {
        const p = await fetchJSON('/backtest/optimize/progress');
        const el = document.getElementById('bt-optimizer-progress');
        const status = document.getElementById('bt-optimizer-status');
        const cur = p.current != null ? p.current : (p.done || 0);
        if (el) {
          el.classList.remove('hidden');
          const pct = p.total > 0 ? Math.round((cur / p.total) * 100) : 0;
          el.textContent = (p.running ? 'Running' : 'Idle') +
            (p.phase ? ' · ' + p.phase : '') +
            (p.riskLevel ? ' · ' + p.riskLevel : '') +
            (p.candidateId ? ' · ' + p.candidateId : '') +
            ' · ' + cur + '/' + (p.total || 0) +
            (p.message ? ' — ' + p.message : '') +
            (p.error ? ' · ERR: ' + p.error : '');
          setBtProgress(Math.max(5, Math.min(99, pct || 5)), p.message || 'Optimizing…');
        }
        if (status && p.running) status.textContent = p.message || 'Optimizing…';
        if (status && p.error && !p.running) status.textContent = p.error;
      } catch (_) {}
    }

    function renderOptimizerResult(report) {
      window._lastOptimizer = report;
      const host = document.getElementById('bt-optimizer-results');
      const status = document.getElementById('bt-optimizer-status');
      if (!host) return;
      const riskBlocks = report && Array.isArray(report.risks) ? report.risks : null;
      if (!riskBlocks || !riskBlocks.length) {
        host.innerHTML = '<p class="mint text-xs text-slate-500">No optimizer results yet</p>';
        return;
      }
      const hours = report.period && report.period.hours != null ? report.period.hours + 'h' : '';
      if (status) {
        status.textContent = 'Optimized ' + riskBlocks.length + ' risk level(s)' +
          (hours ? ' · ' + hours : '') +
          (report.disclaimer ? ' · ' + report.disclaimer.slice(0, 48) + '…' : '');
      }
      host.innerHTML = riskBlocks.map(function (block) {
        const risk = block.riskLevel || 'on';
        const baseline = block.baseline || {};
        const bm = baseline.metrics || {};
        const winnerId = block.winnerId || null;
        const ranked = block.ranked || [];
        const winner = ranked.find(function (c) { return c.id === winnerId; }) || null;
        const rows = ranked.slice(0, 12).map(function (c, idx) {
          const m = c.metrics || {};
          const pass = !!c.passedFloors;
          const isWinner = winnerId && c.id === winnerId;
          const id = c.id || ('cand-' + idx);
          const wr = m.winRatePct != null ? Number(m.winRatePct).toFixed(1) + '%' : '—';
          const trades = m.trades != null ? m.trades : '—';
          const exp = m.expectancySol != null ? Number(m.expectancySol).toFixed(4) : '—';
          const pf = m.profitFactor != null ? Number(m.profitFactor).toFixed(2) : '—';
          const dd = m.maxDrawdownPct != null ? Number(m.maxDrawdownPct).toFixed(1) + '%' : '—';
          const score = m.performanceScore != null ? Number(m.performanceScore).toFixed(1) : '—';
          const floorTip = (c.floorNotes && c.floorNotes.length)
            ? String(c.floorNotes.join('; ')).replace(/"/g, '&quot;')
            : '';
          const label = c.label || id;
          return '<tr style="' + (isWinner ? 'background:rgba(34,197,94,0.08)' : '') + '">' +
            '<td><input type="radio" class="bt-opt-pick" name="bt-opt-' + risk + '" value="' + id +
              '" data-risk="' + risk + '"' + (isWinner ? ' checked' : '') + ' /></td>' +
            '<td class="mint text-xs" title="' + (c.scoreNote || '').replace(/"/g, '&quot;') + '">' +
              label + (c.isBaseline ? ' (base)' : '') + (isWinner ? ' ★' : '') + '</td>' +
            '<td style="color:' + (pass ? '#4ade80' : '#f87171') + '" title="' + floorTip + '">' +
              (pass ? 'pass' : 'fail') + '</td>' +
            '<td>' + wr + '</td>' +
            '<td>' + trades + '</td>' +
            '<td>' + exp + '</td>' +
            '<td>' + pf + '</td>' +
            '<td>' + dd + '</td>' +
            '<td>' + score + '</td>' +
            '</tr>';
        }).join('');
        const baseLine =
          'Baseline WR ' + (bm.winRatePct != null ? Number(bm.winRatePct).toFixed(1) + '%' : '—') +
          ' · trades ' + (bm.trades != null ? bm.trades : '—') +
          ' · exp ' + (bm.expectancySol != null ? Number(bm.expectancySol).toFixed(4) : '—') +
          ' · PF ' + (bm.profitFactor != null ? Number(bm.profitFactor).toFixed(2) : '—');
        return '<div class="border border-slate-700/60 rounded p-2">' +
          '<div class="section-title text-sm mb-1">' + String(risk).toUpperCase() +
            (winner ? ' → ' + (winner.label || winner.id) : ' (no passer)') + '</div>' +
          '<p class="mint text-xs mb-2">' + baseLine + '</p>' +
          '<div class="overflow-x-auto max-h-64 overflow-y-auto">' +
          '<table><thead><tr>' +
          '<th></th><th>Candidate</th><th>Floors</th><th>WR</th><th>Trades</th><th>Exp</th><th>PF</th><th>Max DD</th><th>Score</th>' +
          '</tr></thead><tbody>' +
          (rows || '<tr><td colspan="9" class="text-slate-500">No candidates</td></tr>') +
          '</tbody></table></div></div>';
      }).join('');
    }

    async function stopRiskRecipeOptimizer() {
      const status = document.getElementById('bt-optimizer-status');
      const stopBtn = document.getElementById('bt-optimizer-stop-btn');
      if (stopBtn) stopBtn.disabled = true;
      try {
        const data = await fetchJSON('/backtest/optimize/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (status) status.textContent = data.message || 'Stop requested';
        clearInterval(_optProgressTimer);
        _optProgressTimer = null;
        try {
          const last = await fetchJSON('/backtest/optimize/last');
          if (last && (last.optimizer || last.risks)) {
            renderOptimizerResult(last.optimizer || last);
            if (status) status.textContent = 'Optimizer stopped (partial results)';
          } else if (status) {
            status.textContent = 'Stopped';
          }
        } catch (_) {
          if (status) status.textContent = data.message || 'Stopped';
        }
        hideBtProgress();
      } catch (err) {
        if (status) status.textContent = err.message || 'Stop failed';
      }
    }

    async function runRiskRecipeOptimizer() {
      const risks = selectedOptimizerRisks();
      if (!risks.length) {
        alert('Select at least one risk level');
        return;
      }
      if (!window._lastBacktest) {
        alert('Run a backtest first so the optimizer can reuse that window');
        return;
      }
      const maxEl = document.getElementById('bt-opt-max');
      const maxCandidatesPerRisk = maxEl ? Math.max(4, Math.min(24, Number(maxEl.value) || 16)) : 16;
      const status = document.getElementById('bt-optimizer-status');
      const btn = document.getElementById('bt-optimizer-run-btn');
      const stopBtn = document.getElementById('bt-optimizer-stop-btn');
      const prog = document.getElementById('bt-optimizer-progress');
      if (status) status.textContent = 'Starting optimizer…';
      if (btn) btn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
      if (prog) { prog.classList.remove('hidden'); prog.textContent = 'Starting…'; }
      setBtProgress(5, 'Optimizer…');
      clearInterval(_optProgressTimer);
      _optProgressTimer = setInterval(pollOptimizerProgress, 500);
      let wasCancelled = false;
      try {
        const start = await fetchJSON('/backtest/optimize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            risks: risks,
            maxCandidatesPerRisk: maxCandidatesPerRisk,
            useLastBacktestWindow: true,
          }),
          timeoutMs: 60000,
        });
        if (!start.ok && !start.started) {
          throw new Error(start.error || 'Failed to start');
        }
        let attempts = 0;
        while (attempts < 900) {
          await new Promise(function (r) { setTimeout(r, 1000); });
          attempts++;
          const p = await fetchJSON('/backtest/optimize/progress');
          if (p.phase === 'cancelled' || p.phase === 'stopped') {
            wasCancelled = true;
            break;
          }
          if (!p.running) {
            if (p.error) throw new Error(p.error);
            break;
          }
        }
        try {
          const last = await fetchJSON('/backtest/optimize/last');
          if (last && (last.optimizer || last.risks)) {
            renderOptimizerResult(last.optimizer || last);
          }
        } catch (_) {
          if (wasCancelled && status) status.textContent = 'Stopped';
        }
        if (wasCancelled) {
          setBtProgress(100, 'Optimizer stopped');
          setTimeout(hideBtProgress, 1200);
          if (status) status.textContent = status.textContent || 'Optimizer stopped';
        } else {
          setBtProgress(100, 'Optimizer complete');
          setTimeout(hideBtProgress, 1200);
          if (status) status.textContent = 'Optimizer complete';
        }
      } catch (err) {
        if (status) status.textContent = err.message || 'Optimizer failed';
        hideBtProgress();
      } finally {
        clearInterval(_optProgressTimer);
        _optProgressTimer = null;
        if (btn) btn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
      }
    }

    async function applyOptimizerWinners(applyAllWinners) {
      const status = document.getElementById('bt-optimizer-status');
      let body;
      if (applyAllWinners) {
        if (!confirm(
          'Apply each risk level\\'s constrained-WR winner to synced Risk On/Off recipes?\\n\\n' +
          'Module toggles stay as set. Settings persist for the next applyRiskLevel.'
        )) return;
        body = { applyWinners: true };
      } else {
        const selections = selectedOptimizerCandidateIds();
        if (!selections.length) {
          alert('Select a candidate per risk (radio), or use Apply winners');
          return;
        }
        if (!confirm(
          'Apply ' + selections.length + ' selected candidate(s) to synced risk recipes?\\n\\n' +
          'Module toggles stay as set.'
        )) return;
        body = { selections: selections };
      }
      try {
        const data = await fetchJSON('/backtest/optimize/apply', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (status) status.textContent = data.message || 'Applied to risk recipes';
        if (typeof loadStrategies === 'function') {
          try { loadStrategies(); } catch (_) {}
        }
        if (typeof refreshAll === 'function') {
          try { refreshAll(); } catch (_) {}
        }
      } catch (err) {
        if (status) status.textContent = err.message || 'Apply failed';
        alert(err.message || 'Apply failed');
      }
    }

    async function loadLastOptimizerResult() {
      try {
        const last = await fetchJSON('/backtest/optimize/last');
        if (last && last.optimizer) {
          renderOptimizerResult(last.optimizer);
        }
      } catch (_) {}
    }

    async function togglePaperLiveData() {
      const enabled = document.getElementById('paper-live-data').checked;
      await fetchJSON('/api/paper/live-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const el = document.getElementById('paper-live-status') || document.getElementById('bt-status');
      if (el) el.textContent = 'Live prices ' + (enabled ? 'ON' : 'OFF');
    }

    function fmtPnl(n) {
      if (n == null) return '—';
      if (Math.abs(n) >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M';
      if (Math.abs(n) >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K';
      return '$' + n.toFixed(0);
    }

    let chartCumulative = null;
    let chartWallet = null;
    let chartWinLoss = null;

    const chartDefaults = {
      color: '#c9d1d9',
      borderColor: '#30363d',
      font: { size: 11 },
    };

    function ensureCharts() {
      if (typeof Chart === 'undefined') return;
      Chart.defaults.color = chartDefaults.color;
      Chart.defaults.borderColor = chartDefaults.borderColor;
      Chart.defaults.font.size = chartDefaults.font.size;

      if (!chartCumulative) {
        chartCumulative = new Chart(document.getElementById('chart-cumulative'), {
          type: 'line',
          data: {
            labels: [],
            datasets: [{
              label: 'Cumulative PnL (SOL)',
              data: [],
              borderColor: '#58a6ff',
              backgroundColor: 'rgba(88,166,255,0.15)',
              fill: true,
              tension: 0.25,
              pointRadius: 3,
              pointBackgroundColor: '#58a6ff',
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 10 } },
              y: { title: { display: true, text: 'SOL' } },
            },
          },
        });
      }

      if (!chartWallet) {
        chartWallet = new Chart(document.getElementById('chart-wallet'), {
          type: 'bar',
          data: {
            labels: [],
            datasets: [{
              label: 'PnL (SOL)',
              data: [],
              backgroundColor: [],
              borderRadius: 4,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              y: { title: { display: true, text: 'SOL' } },
            },
          },
        });
      }

      if (!chartWinLoss) {
        chartWinLoss = new Chart(document.getElementById('chart-winloss'), {
          type: 'bar',
          data: {
            labels: ['Wins', 'Losses'],
            datasets: [
              {
                label: 'Count',
                data: [0, 0],
                backgroundColor: ['#3fb950', '#f85149'],
                borderRadius: 4,
                yAxisID: 'y',
              },
              {
                label: 'PnL (SOL)',
                data: [0, 0],
                backgroundColor: ['rgba(63,185,80,0.35)', 'rgba(248,81,73,0.35)'],
                borderRadius: 4,
                yAxisID: 'y1',
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom' } },
            scales: {
              y: { position: 'left', title: { display: true, text: 'Count' }, beginAtZero: true },
              y1: { position: 'right', title: { display: true, text: 'SOL' }, grid: { drawOnChartArea: false } },
            },
          },
        });
      }
    }

    function updateCharts(charts) {
      ensureCharts();
      if (!chartCumulative || !charts) return;

      const hasTrades = (charts.tradeCount || 0) > 0;
      document.getElementById('chart-cumulative-empty').style.display = hasTrades ? 'none' : 'block';
      document.getElementById('chart-wallet-empty').style.display =
        (charts.perWallet?.labels?.length || 0) > 0 ? 'none' : 'block';
      document.getElementById('chart-winloss-empty').style.display = hasTrades ? 'none' : 'block';
      document.getElementById('chart-cumulative').style.display = hasTrades ? 'block' : 'none';
      document.getElementById('chart-wallet').style.display =
        (charts.perWallet?.labels?.length || 0) > 0 ? 'block' : 'none';
      document.getElementById('chart-winloss').style.display = hasTrades ? 'block' : 'none';

      if (hasTrades) {
        chartCumulative.data.labels = charts.cumulativePnl.labels;
        chartCumulative.data.datasets[0].data = charts.cumulativePnl.values;
        const last = charts.cumulativePnl.values[charts.cumulativePnl.values.length - 1] || 0;
        chartCumulative.data.datasets[0].borderColor = last >= 0 ? '#3fb950' : '#f85149';
        chartCumulative.data.datasets[0].backgroundColor =
          last >= 0 ? 'rgba(63,185,80,0.15)' : 'rgba(248,81,73,0.15)';
        chartCumulative.update('none');

        chartWinLoss.data.datasets[0].data = charts.winLoss.counts;
        chartWinLoss.data.datasets[1].data = charts.winLoss.pnlSol;
        chartWinLoss.update('none');
      }

      if (charts.perWallet?.labels?.length) {
        chartWallet.data.labels = charts.perWallet.labels;
        chartWallet.data.datasets[0].data = charts.perWallet.pnlSol;
        chartWallet.data.datasets[0].backgroundColor = charts.perWallet.pnlSol.map(
          (v) => (v >= 0 ? '#3fb950' : '#f85149')
        );
        chartWallet.update('none');
      }
    }

    function fmtToken(symbol, name, mint) {
      return fmtTokenCa(symbol, name, mint);
    }

    function fmtTokenName(symbol, name, mint) {
      const tick = (symbol || (mint ? mint.slice(0, 6) : '?')).trim();
      const full = (name || '').trim();
      if (!full || full.toLowerCase() === tick.toLowerCase()) return '<span class="mint">—</span>';
      return escHtml(full);
    }

    async function paperTopUp() {
      const amountSol = Number(document.getElementById('paper-topup-amount').value);
      const status = document.getElementById('paper-fund-status');
      if (!Number.isFinite(amountSol) || amountSol <= 0) {
        status.textContent = 'Enter a positive SOL amount.';
        return;
      }
      try {
        const data = await fetchJSON('/api/paper/topup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountSol }),
        });
        status.textContent = ' · Topped up +' + amountSol + ' → ' + data.balance.toFixed(4) + ' SOL';
        refresh();
      } catch (err) {
        status.textContent = ' · ' + err.message;
      }
    }

    async function paperReset(clearHistory) {
      const msg = clearHistory
        ? 'Full reset: restore starting balance, clear open positions, AND wipe closed history + logs?'
        : 'Reset paper balance to starting SOL and clear open positions? (closed history kept)';
      if (!confirm(msg)) return;
      const status = document.getElementById('paper-fund-status');
      try {
        const data = await fetchJSON('/api/paper/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clearHistory: !!clearHistory }),
        });
        status.textContent =
          ' · Reset to ' + data.balanceSol.toFixed(4) + ' SOL' +
          (data.clearedOpen ? ' (cleared ' + data.clearedOpen + ' open)' : '') +
          (clearHistory ? ' · history cleared' : '');
        refresh();
      } catch (err) {
        status.textContent = ' · ' + err.message;
      }
    }

    /** Epoch ms of last Overview Reset (from /api/status); null = never. */
    let _lastDashboardResetAt = null;

    function pad2(n) { return n < 10 ? '0' + n : String(n); }

    function formatResetElapsed(ms) {
      if (ms == null || !Number.isFinite(ms)) return '—';
      const totalSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;
      if (days > 0) return days + 'd ' + hours + 'h ' + pad2(mins) + 'm';
      if (hours > 0) return hours + 'h ' + pad2(mins) + 'm ' + pad2(secs) + 's';
      if (mins > 0) return mins + 'm ' + pad2(secs) + 's';
      return secs + 's';
    }

    function formatResetLocal(ms) {
      if (ms == null || !Number.isFinite(ms)) return 'Never reset';
      const d = new Date(ms);
      const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
      const day = pad2(d.getDate());
      const month = pad2(d.getMonth() + 1);
      const year = d.getFullYear();
      const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      return weekday + ' ' + day + '/' + month + '/' + year + ' ' + time;
    }

    function setLastDashboardResetAt(ms) {
      const next =
        ms != null && Number.isFinite(Number(ms)) ? Math.floor(Number(ms)) : null;
      _lastDashboardResetAt = next;
      paintDashboardResetTimer();
    }

    function paintDashboardResetTimer() {
      const elapsedEl = document.getElementById('ov-reset-elapsed');
      const atEl = document.getElementById('ov-reset-at');
      const meta = document.getElementById('ov-reset-meta');
      if (!elapsedEl && !atEl) return;
      if (_lastDashboardResetAt == null) {
        if (elapsedEl) elapsedEl.textContent = '—';
        if (atEl) atEl.textContent = 'Never reset';
        if (meta) meta.title = 'Dashboard has not been reset yet';
        return;
      }
      if (elapsedEl) elapsedEl.textContent = formatResetElapsed(_lastDashboardResetAt);
      if (atEl) atEl.textContent = formatResetLocal(_lastDashboardResetAt);
      if (meta) {
        meta.title =
          'Last Overview Reset: ' + formatResetLocal(_lastDashboardResetAt) +
          ' · elapsed ' + formatResetElapsed(_lastDashboardResetAt);
      }
    }

    function tickDashboardResetTimer() {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      paintDashboardResetTimer();
    }

    async function resetDashboardSession() {
      if (!confirm(
        'Reset dashboard session?\\n\\nClears: SOL balance → start, equity, open & closed trades, PnL, signals, soak stats, skip reasons.\\n\\nKeeps: Risk On/Off and strategy modules.\\n\\nContinue?'
      )) return;
      try {
        const data = await fetchJSON('/api/dashboard/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (data.lastDashboardResetAt != null) {
          setLastDashboardResetAt(data.lastDashboardResetAt);
        } else {
          setLastDashboardResetAt(Date.now());
        }
        await refresh();
        const bal = data.balance != null ? Number(data.balance).toFixed(4) : '—';
        alert('Dashboard reset · balance ' + bal + ' SOL');
      } catch (err) {
        alert('Reset failed: ' + (err.message || err));
      }
    }

    async function forceSellPosition(id, symbol) {
      const label = symbol || id;
      if (!confirm('Force sell entire position for ' + label + '?')) return;
      try {
        await fetchJSON('/api/positions/' + encodeURIComponent(id) + '/sell', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        refresh();
      } catch (err) {
        alert('Force sell failed: ' + (err.message || err));
      }
    }

    async function forceSellAllPositions() {
      try {
        const data = await fetchJSON('/api/positions');
        const open = data.open || [];
        if (open.length === 0) {
          alert('No open positions to sell');
          return;
        }
        if (!confirm('Sell all ' + open.length + ' open positions?')) return;
        const errors = [];
        for (let i = 0; i < open.length; i++) {
          const p = open[i];
          const label = p.symbol || (p.mint ? String(p.mint).slice(0, 6) : p.id);
          try {
            await fetchJSON('/api/positions/' + encodeURIComponent(p.id) + '/sell', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            });
          } catch (err) {
            errors.push(label + ': ' + (err.message || err));
          }
        }
        if (errors.length) {
          alert('Some sells failed (' + errors.length + '/' + open.length + '):\\n' + errors.slice(0, 8).join('\\n'));
        }
        refresh();
      } catch (err) {
        alert('Sell all failed: ' + (err.message || err));
      }
    }

    async function refreshPumpActivity() {
      const filter = (document.getElementById('pump-act-filter') || {}).value || 'all';
      const minSm = Number((document.getElementById('pump-act-min-sm') || {}).value) || 0;
      const q = new URLSearchParams({ limit: '40' });
      if (filter === 'early') q.set('early', '1');
      if (filter === 'near') q.set('nearMigration', '1');
      if (filter === 'migration') q.set('migration', '1');
      if (filter === 'priority') q.set('priority', '1');
      if (minSm > 0) q.set('minSm', String(minSm));
      try {
        const data = await fetchJSON('/api/pump-activity?' + q.toString());
        const tbody = document.querySelector('#pump-activity-table tbody');
        const rows = data.events || [];
        if (tbody) {
          tbody.innerHTML = rows.length === 0
            ? '<tr><td colspan="7" style="color:var(--muted)">No Pump.fun smart activity yet — waiting for tracked wallet buys on curve</td></tr>'
            : rows.map(e => {
                const kindColor = e.kind === 'migration' || e.isMigration
                  ? 'var(--green)'
                  : e.kind === 'near_migration' || e.nearMigration
                    ? 'var(--green)'
                    : e.earlyBuy || e.kind === 'early_buy'
                      ? '#3b82f6'
                      : 'var(--muted)';
                return '<tr>' +
                  '<td>' + fmtToken(e.symbol, e.name, e.mint) +
                  (e.priority ? ' <span class="mint">prio</span>' : '') + '</td>' +
                  '<td style="color:' + kindColor + '">' + (e.kind || '—') + '</td>' +
                  '<td>' + (e.curveProgressPct != null ? Number(e.curveProgressPct).toFixed(0) + '%' : '—') +
                  (e.nearMigration ? ' · near' : '') + '</td>' +
                  '<td>' + (e.walletNames || []).slice(0, 3).join(', ') +
                  (e.earlyBuyerCount > 1 ? ' <span class="mint">×' + e.earlyBuyerCount + '</span>' : '') + '</td>' +
                  '<td>' + (e.smartMoneyScore != null ? e.smartMoneyScore : '—') +
                  (e.birdeye && e.birdeye.volume24hUsd != null ? ' · $' + Number(e.birdeye.volume24hUsd).toFixed(0) : '') + '</td>' +
                  '<td class="mint">' + (e.notes || (e.birdeye && e.birdeye.flags ? e.birdeye.flags.slice(0, 2).join(' · ') : '—')) + '</td>' +
                  '<td class="mint">' + fmtTimeAgoCell(e.timestamp) + '</td>' +
                  '</tr>';
              }).join('');
        }
        ensurePosHoldTicker();
        tickOpenPositionHolds();
        const hot = document.getElementById('pump-hot-launches');
        if (hot && data.launches) {
          const launches = data.launches.filter(l => (l.earlyBuyers || []).length > 0 || l.migrated).slice(0, 6);
          hot.innerHTML = launches.length
            ? 'Tracked launches: ' + launches.map(l =>
                fmtTokenCa(l.symbol, l.name, l.mint) +
                ' <span class="mint">(' + (l.earlyBuyers || []).length + ' early' +
                (l.lastProgressPct != null ? ' · ' + Number(l.lastProgressPct).toFixed(0) + '%' : '') +
                (l.migrated ? ' · mig' : '') + ')</span>'
              ).join(' · ')
            : '';
        }
        const st = document.getElementById('pump-act-status');
        if (st && data.status) {
          st.textContent =
            (data.status.eventCount || 0) + ' events · early max ' +
            (data.status.earlyCurveMaxPct ?? 35) + '% · min SM ' +
            (data.status.minEarlyBirdeyeSmartMoneyScore ?? 40);
        }
      } catch (err) {
        const st = document.getElementById('pump-act-status');
        if (st) st.textContent = 'Pump activity error: ' + (err.message || err);
      }
    }

    async function discoverPumpSmart() {
      const st = document.getElementById('pump-act-status');
      if (st) st.textContent = 'Discovering Pump.fun smart money…';
      try {
        const data = await fetchJSON('/api/discover-pump-smart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20, force: true }),
          timeoutMs: 45000,
        });
        window._discoveredWallets = data.wallets || [];
        if (st) {
          st.textContent = data.message ||
            ((data.wallets || []).length + ' wallets · ' + (data.hotLaunches || []).length + ' hot launches');
        }
        const hot = document.getElementById('pump-hot-launches');
        if (hot) {
          const hl = data.hotLaunches || [];
          hot.textContent = hl.length
            ? 'Hot launches: ' + hl.slice(0, 8).map(t =>
                t.symbol +
                (t.progressPct != null ? ' ' + Number(t.progressPct).toFixed(0) + '%' : '') +
                (t.smartMoneyScore != null ? ' SM' + t.smartMoneyScore : '') +
                (t.nearMigration ? ' near-mig' : '')
              ).join(' · ')
            : 'No hot launches (need Birdeye key for trending)';
        }
        const src = document.getElementById('discover-source');
        if (src) src.value = 'pump';
        discoverWallets(true);
      } catch (err) {
        if (st) st.textContent = 'Discover failed: ' + (err.message || err);
      }
    }

    async function refresh() {
      if (window._refreshInFlight) return;
      window._refreshInFlight = true;
      try {
      const [status, positions, logs, activity, cfg, walletsRaw, migrations, paper, sized, dipSm, scanner, zionData] = await Promise.all([
        fetchJSON('/api/status'),
        fetchJSON('/api/positions'),
        fetchJSON('/api/logs?limit=50'),
        fetchJSON('/api/activity'),
        fetchJSON('/api/config'),
        fetchJSON('/wallets'),
        fetchJSON('/api/migrations'),
        fetchJSON('/paper-status'),
        fetchJSON('/api/signals').catch(() => ({ signals: [], trade: {} })),
        fetchJSON('/api/post-run-dip/smart-wallet').catch(() => ({ events: [], config: {} })),
        fetchJSON('/api/market-scanner').catch(() => ({ status: {}, candidates: [] })),
        fetchJSON('/api/zion').catch(() => null),
      ]);
      try { if (zionData) handleZionRefresh(zionData); } catch (_) {}
      _lastConfig = cfg;
      applyStrategyConfigValues(cfg);
      const wallets = Array.isArray(walletsRaw) ? walletsRaw : (walletsRaw && walletsRaw.wallets) || [];

      updateCharts(paper && paper.charts);
      if (paper.useLiveData != null) {
        document.getElementById('paper-live-data').checked = !!paper.useLiveData;
        document.getElementById('bt-live').checked = !!paper.useLiveData;
      }

      const persistEl = document.getElementById('persist-banner');
      if (persistEl) {
        const p = status.persistence;
        if (p && p.warning) {
          persistEl.style.display = 'block';
          persistEl.innerHTML =
            '<strong>Settings / wallets will reset on deploy</strong> — ' +
            String(p.warning).replace(/</g, '&lt;') +
            ' <span class="mint">(' + String(p.dataDir || '').replace(/</g, '&lt;') + ')</span>';
        } else {
          persistEl.style.display = 'none';
          persistEl.textContent = '';
        }
      }

      const runWrap = document.getElementById('run-status');
      const dot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      const runIcon = document.getElementById('run-status-icon');
      let runState = 'running';
      let runLabel = 'Running';
      let runIconKey = 'play';
      if (!status.monitor.running) {
        runState = 'stopped';
        runLabel = 'Stopped';
        runIconKey = 'stop';
      } else if (status.monitor.paused) {
        runState = 'paused';
        runLabel = 'Paused';
        runIconKey = 'pause';
      }
      if (dot) {
        dot.className =
          'dot ' +
          (runState === 'paused'
            ? 'dot-paused'
            : runState === 'stopped'
              ? 'dot-stopped'
              : 'dot-running');
      }
      if (statusText) statusText.textContent = runLabel;
      if (runWrap) {
        runWrap.className = 'run-status run-' + runState + ' has-tip';
        runWrap.title =
          runState === 'running'
            ? 'Monitor is running and polling wallets'
            : runState === 'paused'
              ? 'Monitor is paused — no new copy entries'
              : 'Monitor is stopped';
      }
      setStatusIcon(runIcon, runIconKey);
      syncOverviewRunModeStatus(runState, runLabel, runIconKey, status);

      document.getElementById('btn-pause').textContent = status.monitor.paused ? 'Resume' : 'Pause';

      const badge = document.getElementById('mode-badge');
      const modeLabelEl = document.getElementById('mode-badge-label');
      const modeIcon = document.getElementById('mode-badge-icon');
      const modeLabel = status.modeLabel || (status.mode === 'liveSimulation' ? 'LIVE SIM' : String(status.mode || 'paper').toUpperCase());
      if (modeLabelEl) modeLabelEl.textContent = modeLabel;
      else if (badge) badge.textContent = modeLabel;
      if (badge) {
        badge.className = 'badge status-badge has-tip ' + (
          status.mode === 'live' ? 'badge-live' :
          status.mode === 'liveSimulation' ? 'badge-livesim' :
          'badge-paper'
        );
        badge.title = status.mode === 'live'
          ? 'LIVE = real swaps with trading wallet keys'
          : status.mode === 'liveSimulation'
            ? 'LIVE SIM = virtual fills + live market data / live filters (no real funds)'
            : 'PAPER = simulated fills';
      }
      setStatusIcon(
        modeIcon,
        status.mode === 'live' ? 'live' : status.mode === 'liveSimulation' ? 'liveSim' : 'paper'
      );
      ['paper', 'liveSimulation', 'live'].forEach((mode) => {
        const btn = document.getElementById('mode-' + mode);
        if (!btn) return;
        const active = status.mode === mode;
        btn.className = active
          ? (mode === 'live' ? 'btn btn-danger' : 'btn btn-primary')
          : 'btn btn-secondary';
      });

      // Live Sim vs Backtest compare UI lives on Backtester only
      refreshPerformanceCompare();

      const verEl = document.getElementById('app-version');
      if (verEl && status.app) {
        verEl.textContent = status.app.label || ('v' + status.app.version);
        const when = status.app.updatedAt
          ? new Date(status.app.updatedAt).toLocaleString()
          : '';
        verEl.title = 'Version ' + status.app.version +
          (when ? ' · updated ' + when : '') +
          (status.app.gitSha ? ' · ' + status.app.gitSha : '');
      }

      const ms = status.marketSession;
      const msBadge = document.getElementById('market-session-badge');
      const msLabel = document.getElementById('market-session-label');
      const msLive = document.getElementById('market-session-live');
      if (ms && msLabel) {
        const pref = ms.preferred ? ' ★' : '';
        const gate = ms.filterEnabled
          ? (ms.allowed ? '' : ' (blocked)')
          : ' (filter off)';
        msLabel.textContent = 'Session: ' + ms.label + pref;
        if (msBadge) {
          msBadge.title =
            'UTC ' + String(ms.utcHour).padStart(2, '0') + ':00 · ' +
            ms.label +
            (ms.filterEnabled
              ? ms.allowed
                ? ' · entries allowed'
                : ' · entries blocked'
              : ' · session filter OFF') +
            (ms.preferred ? ' · preferred' : '');
          msBadge.style.color = !ms.filterEnabled
            ? '#94a3b8'
            : ms.allowed
              ? ms.preferred
                ? '#6ee7b7'
                : '#e2e8f0'
              : '#fca5a5';
          msBadge.style.borderColor = !ms.filterEnabled
            ? '#334155'
            : ms.allowed
              ? '#334155'
              : '#7f1d1d';
        }
        if (msLive) {
          msLive.textContent =
            'Current session: ' + ms.label +
            ' (UTC ' + String(ms.utcHour).padStart(2, '0') + ':00)' +
            pref + gate;
        }
      }

      const tw = status.tradingWallet;
      const liveStatus = document.getElementById('live-wallet-status');
      if (liveStatus && tw) {
        liveStatus.textContent = 'Active: ' + tw.name + (tw.publicKey ? ' · ' + tw.publicKey.slice(0,8) + '…' : ' · no key');
      }

      const risk = status.monitor?.risk;
      const riskEl = document.getElementById('risk-status');
      if (riskEl && risk) {
        riskEl.textContent =
          (risk.halted ? '⛔ HALTED (' + risk.haltReason + ') · ' : '') +
          'Equity ' + (risk.equitySol ?? 0).toFixed(3) + ' SOL · DD ' + (risk.drawdownPct ?? 0).toFixed(1) +
          '% · Day PnL ' + (risk.dailyPnlSol ?? 0).toFixed(3) +
          ' · Week PnL ' + (risk.weeklyPnlSol ?? 0).toFixed(3) +
          (risk.tieredSellEnabled ? ' · tiered ON' : '') +
          (risk.useRiskSizing ? ' · risk sizing ON' : '');
      }
      updateRiskLevelUI(cfg);

      const beKey = document.getElementById('discover-key-status');
      const be = status.monitor?.birdeye || cfg?.birdeye;
      if (beKey && be && document.activeElement !== beKey) {
        beKey.textContent = be.hasApiKey
          ? 'Birdeye key ✓ (token + smart money)'
          : 'No BIRDEYE_API_KEY (Dex fallback)';
      }

      document.getElementById('balance').textContent = status.balance != null ? Number(status.balance).toFixed(4) : '—';
      document.getElementById('daily-pnl').textContent =
        status.monitor && status.monitor.dailyPnlSol != null
          ? Number(status.monitor.dailyPnlSol).toFixed(4)
          : '—';
      const port = status.portfolio || {};
      const availSol = port.availableBalanceSol != null ? Number(port.availableBalanceSol)
        : (status.balance != null ? Number(status.balance) : null);
      const posValSol = port.positionsValueSol != null ? Number(port.positionsValueSol) : null;
      const equitySol = port.totalEquitySol != null ? Number(port.totalEquitySol)
        : (status.equity != null ? Number(status.equity) : null);
      const unrealSol = port.unrealizedPnlSol != null ? Number(port.unrealizedPnlSol) : null;
      const realizedSol = port.realizedPnlSol != null ? Number(port.realizedPnlSol)
        : (status.stats && status.stats.netPnlSol != null ? Number(status.stats.netPnlSol) : null);
      const openCnt = port.openCount != null ? port.openCount
        : (status.stats && status.stats.openTrades != null ? status.stats.openTrades : null);

      const fmtSolCompact = (n) => {
        if (n == null || !Number.isFinite(n)) return '—';
        const abs = Math.abs(n);
        const dig = abs >= 100 ? 2 : abs >= 10 ? 3 : 4;
        return n.toFixed(dig);
      };
      const solUsdRate =
        status.solUsd != null && Number(status.solUsd) > 0
          ? Number(status.solUsd)
          : null;
      /** Muted USD in brackets — SOL stays primary. */
      const fmtUsdBracket = (solAmt, opts) => {
        const signed = opts && opts.signed;
        if (solAmt == null || !Number.isFinite(solAmt) || !(solUsdRate > 0)) {
          return '';
        }
        const usd = solAmt * solUsdRate;
        const abs = Math.abs(usd);
        let num;
        if (abs >= 100) num = Math.round(abs).toLocaleString('en-US');
        else if (abs >= 10) num = abs.toFixed(1);
        else num = abs.toFixed(2);
        let sign = '';
        if (signed) {
          if (usd > 0) sign = '+';
          else if (usd < 0) sign = '-';
        } else if (usd < 0) {
          sign = '-';
        }
        return (
          '<span class="ov-usd">(' + sign + '$' + num + ' USD)</span>'
        );
      };
      const colorPnL = (el, n) => {
        if (!el) return;
        if (n == null || !Number.isFinite(n)) { el.style.color = ''; return; }
        el.style.color = n > 0 ? 'var(--green)' : n < 0 ? 'var(--red)' : 'var(--muted)';
      };

      const eqEl = document.getElementById('ov-equity');
      if (eqEl) {
        eqEl.innerHTML = (equitySol != null ? fmtSolCompact(equitySol) : '—') +
          '<span class="ov-unit">SOL</span>' +
          fmtUsdBracket(equitySol);
        colorPnL(eqEl, equitySol != null && port.startingBalanceSol != null
          ? equitySol - Number(port.startingBalanceSol)
          : null);
        if (equitySol != null) eqEl.style.color = '#34d399';
      }
      const hdrEq = document.getElementById('header-equity');
      if (hdrEq) hdrEq.textContent = equitySol != null ? fmtSolCompact(equitySol) : '—';

      if (status.lastDashboardResetAt !== undefined) {
        setLastDashboardResetAt(status.lastDashboardResetAt);
      }

      const availEl = document.getElementById('ov-available');
      if (availEl) {
        availEl.innerHTML = availSol != null
          ? (fmtSolCompact(availSol) + ' SOL' + fmtUsdBracket(availSol))
          : '—';
      }
      const posEl = document.getElementById('ov-positions-val');
      if (posEl) {
        posEl.innerHTML = posValSol != null
          ? (fmtSolCompact(posValSol) + ' SOL' + fmtUsdBracket(posValSol))
          : '—';
      }
      if (document.getElementById('balance') && availSol != null) {
        document.getElementById('balance').textContent = fmtSolCompact(availSol);
      }
      const _ob = document.getElementById('ov-balance-mirror');
      if (_ob) _ob.textContent = availSol != null ? fmtSolCompact(availSol) : '—';
      const _od = document.getElementById('ov-daily-mirror');
      if (_od) {
        const day = status.monitor && status.monitor.dailyPnlSol != null
          ? Number(status.monitor.dailyPnlSol) : null;
        if (day != null) {
          _od.innerHTML =
            (day >= 0 ? '+' : '') +
            fmtSolCompact(day) +
            ' SOL' +
            fmtUsdBracket(day, { signed: true });
        } else {
          _od.textContent = '—';
        }
        colorPnL(_od, day);
      }
      const openCountEl = document.getElementById('open-count');
      if (openCountEl && openCnt != null) {
        openCountEl.textContent = String(openCnt);
      }

      // RPC status
      const rpc = status.rpc || {};
      const activeEp = (rpc.endpoints || []).find(e => e.isActive) || {};
      const rpcActiveEl = document.getElementById('rpc-active');
      const rpcWrap = document.getElementById('rpc-status-wrap');
      const rpcIcon = document.getElementById('rpc-health-icon');
      if (rpcActiveEl) {
        const rpcLabel = String(rpc.active || '—');
        rpcActiveEl.textContent = rpcLabel.length > 18
          ? rpcLabel.slice(0, 16) + '…'
          : rpcLabel;
        rpcActiveEl.style.color = '';
      }
      if (rpcWrap) {
        rpcWrap.classList.remove('rpc-ok', 'rpc-bad', 'rpc-unknown');
        if (rpc.ok === false) rpcWrap.classList.add('rpc-bad');
        else if (rpc.ok === true) rpcWrap.classList.add('rpc-ok');
        else rpcWrap.classList.add('rpc-unknown');
        rpcWrap.title =
          rpc.ok === false
            ? (rpc.warning || 'RPC unhealthy — wallet buys may not be detected')
            : 'Active Solana RPC: ' + (rpc.active || '—');
      }
      setStatusIcon(rpcIcon, rpc.ok === false ? 'activityBad' : 'activity');
      document.getElementById('rpc-latency').textContent =
        activeEp.latencyMs != null ? activeEp.latencyMs + 'ms' : '—';
      document.getElementById('rpc-summary').textContent =
        'Primary active: ' + (rpc.active || '—') +
        ' · Endpoints: ' + ((rpc.endpoints || []).length) +
        ' · Failover after: ' + (rpc.failoverDownMs != null
          ? (Number(rpc.failoverDownMs) < 60000
              ? Math.round(Number(rpc.failoverDownMs) / 1000) + 's'
              : Math.round(Number(rpc.failoverDownMs) / 60000) + 'm')
          : '30s') +
        ' · Priority fee est: ' + (rpc.priorityFeeLamports != null ? rpc.priorityFeeLamports + ' lamports' : 'n/a');
      const laneSt = document.getElementById('rpc-lane-status');
      if (laneSt) {
        const p = rpc.primary || {};
        const s = rpc.secondary || {};
        laneSt.textContent =
          'Primary lane: ' + (p.label || '—') +
          (p.failover ? ' (FAILOVER)' : '') +
          (p.healthy === false ? ' · preferred DOWN' : '') +
          ' · Secondary lane: ' + (s.label || '—') +
          (s.failover ? ' (FAILOVER)' : '') +
          (s.healthy === false ? ' · preferred DOWN' : '') +
          (rpc.lanesShareEndpoint ? ' · SHARED ENDPOINT (set distinct RPC_SECONDARY)' : '');
      }
      const rpcBanner = document.getElementById('rpc-banner');
      if (rpcBanner) {
        if (rpc.ok === false) {
          rpcBanner.style.display = 'block';
          rpcBanner.style.background = 'rgba(248,81,73,0.15)';
          rpcBanner.style.borderColor = 'rgba(248,81,73,0.45)';
          rpcBanner.textContent =
            rpc.warning ||
            'RPC unhealthy — no wallet buys can be detected. Fix RPC_URL on Render (replace any placeholder with a real Helius/QuickNode URL).';
        } else if (rpc.warning) {
          rpcBanner.style.display = 'block';
          rpcBanner.style.background = 'rgba(210,153,34,0.12)';
          rpcBanner.style.borderColor = 'rgba(210,153,34,0.4)';
          rpcBanner.textContent = rpc.warning;
        } else {
          rpcBanner.style.display = 'none';
          rpcBanner.textContent = '';
        }
      }
      const rpcBody = document.querySelector('#rpc-table tbody');
      if (rpcBody) {
        rpcBody.innerHTML = (rpc.endpoints || []).length === 0
          ? '<tr><td colspan="6" style="color:var(--muted)">No RPC endpoints configured</td></tr>'
          : rpc.endpoints.map(e => \`
            <tr>
              <td title="\${e.url}">\${e.label}</td>
              <td>\${e.lane || e.role || '—'}</td>
              <td>\${e.healthy ? '✅' : '❌'}</td>
              <td>\${e.latencyMs != null ? e.latencyMs + 'ms' : '—'}</td>
              <td>\${e.successRate != null ? Number(e.successRate).toFixed(0) : '—'}% (\${e.successCount || 0}/\${(e.successCount || 0) + (e.failureCount || 0)})</td>
              <td>\${e.isActive ? '●' : ''}</td>
            </tr>\`).join('');
      }
      const jito = status.jito || {};
      const mev = status.mev || {};
      const js = mev.jitoStats || {};
      document.getElementById('jito-status').textContent =
        'Jito: ' + (jito.enabled ? 'ON' : 'OFF') +
        ' · tip ' + (jito.tipLamports ?? '—') + ' lamports' +
        ' · bundles ' + (js.bundlesSucceeded ?? 0) + '/' + (js.bundlesAttempted ?? 0) +
        (js.lastError ? ' · last err: ' + js.lastError : '');

      const mevEl = document.getElementById('mev-status');
      if (mevEl) {
        const sand = mev.lastSandwichCheck;
        mevEl.textContent =
          (mev.enableMEVProtection ? 'MEV ON' : 'MEV OFF') +
          ' · jito bundles ' + (mev.useJitoBundles ? 'yes' : 'no') +
          ' · sandwich ' + (mev.sandwichProtection ? 'yes' : 'no') +
          ' · tip x' + (mev.tipMultiplier ?? 1) +
          ' · prio x' + (mev.priorityFeeMultiplier ?? 1) +
          (sand ? ' · last check: ' + (sand.safe ? 'safe' : 'RISK') + ' (' + sand.suspiciousBuys + ' buyers)' : '');
      }

      document.getElementById('watched').textContent =
        (status.monitor.watchedWallets ?? 0) + ' / ' + (status.monitor.trackedWallets ?? status.monitor.watchedWallets ?? 0);
      const watchedSub = document.getElementById('watched-sub');
      if (watchedSub) {
        watchedSub.textContent =
          status.monitor.watchingLabel ||
          ('Watching ' + (status.monitor.watchedWallets ?? 0) + ' wallets');
      }
      const watchStatus = document.getElementById('watching-status');
      if (watchStatus) {
        watchStatus.textContent =
          (status.monitor.watchingLabel ||
            ('Watching ' + (status.monitor.watchedWallets ?? 0) + ' of ' +
              (status.monitor.trackedWallets ?? 0) + ' wallets')) +
          (status.monitor.running
            ? status.monitor.paused
              ? ' · paused'
              : ' · polling'
            : ' · monitor stopped');
      }
      const watchListEl = document.getElementById('watching-list');
      if (watchListEl) {
        const list = status.monitor.watchingList || [];
        const maxShow = 40;
        const shown = list.slice(0, maxShow);
        watchListEl.textContent = list.length
          ? shown
              .map((w) => w.name + (w.source ? ' (' + w.source + ')' : ''))
              .join(' · ') +
            (list.length > maxShow ? ' · … +' + (list.length - maxShow) + ' more' : '')
          : 'No wallets currently on the poll list — import wallets or Force Refresh Monitoring.';
      }
      document.getElementById('open-count').textContent = status.monitor.openPositions;
      document.getElementById('signals').textContent = status.monitor.recentSignals;
      (function updateSignalLight() {
        const light = status.monitor.signalLight || {};
        const state = light.state || ((!status.monitor.running || status.monitor.paused) ? (status.monitor.paused ? 'paused' : 'off') : 'quiet');
        const label = light.label || (
          state === 'live' ? 'Signals: LIVE' :
          state === 'paused' ? 'Signals: paused' :
          state === 'off' ? 'Signals: off' :
          'Signals: quiet'
        );
        const dot = document.getElementById('signal-light-dot');
        const lab = document.getElementById('signal-light-label');
        const wrap = document.getElementById('signal-light');
        if (dot) {
          const cls =
            state === 'live' ? 'dot-live' :
            state === 'paused' ? 'dot-paused' :
            state === 'off' ? 'dot-off' :
            'dot-quiet';
          dot.className = 'dot ' + cls;
        }
        if (lab) lab.textContent = label;
        if (wrap) {
          const age = light.ageMs != null ? Math.round(light.ageMs / 60000) + 'm ago' : 'none yet';
          wrap.title =
            'Green = wallet-buy seen in last 15m (monitor running + wallets watched). ' +
            'Amber = running but quiet (or paused). ' +
            'Red = stopped, no wallets, or RPC unhealthy. ' +
            'Last signal: ' + age + ' · 24h count: ' + (light.signals24h ?? status.monitor.recentSignals ?? 0);
        }
      })();
      document.getElementById('win-rate').textContent = status.winRate != null ? status.winRate.toFixed(0) + '%' : '—';

      const s = status.stats || {};
      document.getElementById('stat-trades').textContent = s.totalTrades ?? 0;
      // Prefer showing open+closed breakdown when available
      const openN = s.openTrades ?? status.monitor?.openPositions ?? 0;
      const closedN = s.closedTrades;
      if (closedN != null || openN) {
        const tip = document.querySelector('#stat-trades')?.parentElement?.querySelector('.tip');
        if (tip) tip.setAttribute('data-tip',
          (openN || 0) + ' open · ' + (closedN ?? Math.max(0, (s.totalTrades || 0) - (openN || 0))) + ' closed');
      }
      document.getElementById('stat-wl').textContent = (s.wins ?? 0) + ' / ' + (s.losses ?? 0);
      const ur = sumOpenUnrealized(positions.open);
      const pfUr = status.portfolio && status.portfolio.unrealizedPnlSol != null
        ? Number(status.portfolio.unrealizedPnlSol)
        : ur.sol;
      const urEl = document.getElementById('stat-unrealized');
      if (urEl) {
        const openNUr = status.portfolio?.openCount ?? ur.openN;
        const markedUr = status.portfolio?.markedCount ?? ur.marked;
        if (openNUr === 0) {
          urEl.innerHTML = '+0 SOL' + fmtUsdBracket(0, { signed: true });
          urEl.style.color = 'var(--muted)';
        } else if (markedUr === 0 && !(status.portfolio && status.portfolio.unrealizedPnlSol != null)) {
          urEl.textContent = '—';
          urEl.style.color = 'var(--muted)';
        } else {
          const sign = pfUr > 0 ? '+' : '';
          urEl.innerHTML =
            sign +
            Number(pfUr).toFixed(4) +
            ' SOL' +
            fmtUsdBracket(pfUr, { signed: true });
          urEl.style.color = pfUr > 0 ? 'var(--green)' : pfUr < 0 ? 'var(--red)' : 'var(--muted)';
        }
      }
      const urHint = document.getElementById('stat-unrealized-hint');
      if (urHint) {
        const openNUr = status.portfolio?.openCount ?? ur.openN;
        const markedUr = status.portfolio?.markedCount ?? ur.marked;
        urHint.textContent = openNUr === 0
          ? 'No open trades'
          : markedUr + '/' + openNUr + ' marked';
      }
      const ddEl = document.getElementById('stat-maxdd');
      const maxDd = s.maxDrawdownPct ?? 0;
      if (ddEl) {
        ddEl.textContent = maxDd.toFixed(1) + '%';
        ddEl.style.color = maxDd <= 15 ? 'var(--green)' : maxDd <= 25 ? 'var(--muted)' : 'var(--red)';
      }
      const holdEl = document.getElementById('stat-avg-hold');
      if (holdEl && s.avgHoldSec) {
        const m = Math.round(s.avgHoldSec / 60);
        holdEl.textContent = 'Avg hold ' + (m >= 60 ? Math.round(m / 60) + 'h' : m + 'm');
      }
      const trEl = document.getElementById('stat-trade-rate');
      const tr = status.monitor?.tradeRate;
      if (trEl && tr) {
        trEl.textContent = tr.maxTradesPerHour > 0
          ? tr.tradesLastHour + '/' + tr.maxTradesPerHour + '/hr'
          : tr.tradesLastHour + '/hr';
      }
      const pnlEl = document.getElementById('stat-pnl');
      const realized = status.portfolio?.realizedPnlSol != null
        ? Number(status.portfolio.realizedPnlSol)
        : Number(s.netPnlSol ?? 0);
      const rSign = realized > 0 ? '+' : '';
      if (pnlEl) {
        pnlEl.innerHTML =
          rSign +
          realized.toFixed(4) +
          ' SOL' +
          fmtUsdBracket(realized, { signed: true });
        pnlEl.style.color = realized >= 0 ? 'var(--green)' : 'var(--red)';
      }
      const retEl = document.getElementById('stat-return');
      const retPct = status.portfolio?.returnPct != null
        ? Number(status.portfolio.returnPct)
        : Number(s.returnPct ?? 0);
      if (retEl) {
        retEl.textContent = retPct.toFixed(1) + '%';
        retEl.style.color = retPct >= 0 ? 'var(--green)' : 'var(--red)';
      }
      const migrationsHtml =
        (migrations.recent || []).length === 0
          ? '<div style="color:var(--muted)">No recent migrations detected — listening for Pump.fun graduation…</div>'
          : migrations.recent.map(m => \`
            <div class="log-entry">
              \${m.priority ? '⚡' : '🚀'}
              <strong>\${(m.program || 'mig').toUpperCase()}</strong>
              mint \${fmtMintCa(m.mint)}
              \${m.poolAddress ? '· pool <span class="mint" title="' + escAttr(m.poolAddress) + '">' + escHtml(m.poolAddress.slice(0,8)) + '…</span>' : ''}
              \${m.volumeSpike ? '· <strong>vol spike ' + (m.volumeSol ?? 0).toFixed(1) + ' SOL</strong>' : (m.volumeSol ? '· ' + m.volumeSol.toFixed(1) + ' SOL' : '')}
              \${m.smartWalletNames?.length ? '· ' + m.smartWalletNames.join(', ') : ''}
              \${m.priorityReason ? '<span class="mint">(' + escHtml(m.priorityReason) + ')</span>' : ''}
              <span class="mint">\${m.source || ''} · \${fmtTimeAgoCell(m.timestamp || m.detectedAt)}</span>
            </div>
          \`).join('');
      ['migrations', 'trades-migrations'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = migrationsHtml;
      });

      const migStatus = migrations.status || {};
      const migLiveText =
        (migStatus.wsMode ? 'WS live' : 'poll fallback') +
        ' · ' + (migStatus.recentCount ?? 0) + ' tracked' +
        (migStatus.reconnectAttempts ? ' · reconnects:' + migStatus.reconnectAttempts : '') +
        (migStatus.priorityEnabled ? ' · priority ON' : ' · priority OFF');
      ['mig-live-status', 'trades-mig-live-status'].forEach((id) => {
        const migLive = document.getElementById(id);
        if (migLive) migLive.textContent = migLiveText;
      });
      const pf = Number(s.profitFactor ?? 0);
      document.getElementById('stat-detail').textContent =
        'PF ' + (pf >= 999 ? '∞' : pf.toFixed(2)) +
        ' · maxDD ' + maxDd.toFixed(1) + '%' +
        ' · Avg win ' + (s.avgWinPct ?? 0).toFixed(1) + '% · Avg loss ' + (s.avgLossPct ?? 0).toFixed(1) +
        '% · Migrations: ' + (migStatus.recentCount ?? 0) +
        (status.monitor?.selectiveEnabled ? ' · selective ON' : '') +
        (migStatus.wsMode ? ' (WS live)' : ' (poll)');

      if (!window._cfgLoaded) {
        window._cfgLoaded = true;
        Object.entries(cfg.trade).forEach(([k,v]) => {
          const el = document.getElementById(k);
          if (el) { el.value = v; const lab = document.getElementById('v-'+k); if (lab) lab.textContent = v; }
        });
        // Prefer baseTradeAmountSol for the main size slider (alias of tradeAmountSol)
        if (cfg.trade.baseTradeAmountSol != null) {
          const el = document.getElementById('tradeAmountSol');
          const lab = document.getElementById('v-tradeAmountSol');
          if (el) el.value = cfg.trade.baseTradeAmountSol;
          if (lab) lab.textContent = cfg.trade.baseTradeAmountSol;
        }
        Object.entries(cfg.filters).forEach(([k,v]) => {
          if (typeof v === 'boolean') {
            const el = document.getElementById(k);
            if (el) el.checked = v;
          } else {
            const el = document.getElementById(k);
            if (el) { el.value = v; const lab = document.getElementById('v-'+k); if (lab) lab.textContent = v; }
          }
        });
        // Alias: minHolders preferred over minHolderCount in UI
        const holdersVal = cfg.filters.minHolders ?? cfg.filters.minHolderCount;
        const holdersEl = document.getElementById('minHolders');
        if (holdersEl && holdersVal != null) {
          holdersEl.value = holdersVal;
          const lab = document.getElementById('v-minHolders');
          if (lab) lab.textContent = holdersVal;
        }
        document.getElementById('enableMigrationOnly').checked = cfg.strategy.enableMigrationOnly;
        document.getElementById('enableAutoSell').checked = cfg.strategy.enableAutoSell !== false;
        const skipAuth = document.getElementById('skipIfMintAuthority');
        if (skipAuth) skipAuth.checked = !!cfg.filters.skipIfMintAuthority;
        const sensEl = document.getElementById('sniperSensitivity');
        if (sensEl && cfg.filters.sniperSensitivity) {
          sensEl.value = cfg.filters.sniperSensitivity;
        }
        const socialSens = document.getElementById('socialSentimentSensitivity');
        if (socialSens && cfg.filters.socialSentimentSensitivity) {
          socialSens.value = cfg.filters.socialSentimentSensitivity;
        }
        const narrSens = document.getElementById('trendingNarrativeSensitivity');
        if (narrSens && cfg.filters.trendingNarrativeSensitivity) {
          narrSens.value = cfg.filters.trendingNarrativeSensitivity;
        }
        const narrBoost = document.getElementById('trendingNarrativeBoostPoints');
        if (narrBoost && cfg.filters.trendingNarrativeBoostPoints != null) {
          narrBoost.value = cfg.filters.trendingNarrativeBoostPoints;
        }
        const volSens = document.getElementById('volumeSpikeSensitivity');
        if (volSens && cfg.filters.volumeSpikeSensitivity) {
          volSens.value = cfg.filters.volumeSpikeSensitivity;
        }
        const volWin = document.getElementById('volumeSpikeWindowMinutes');
        if (volWin && cfg.filters.volumeSpikeWindowMinutes != null) {
          volWin.value = cfg.filters.volumeSpikeWindowMinutes;
        }
        const volMult = document.getElementById('volumeSpikeMultiplier');
        if (volMult && cfg.filters.volumeSpikeMultiplier != null) {
          volMult.value = cfg.filters.volumeSpikeMultiplier;
        }
        const volBuy = document.getElementById('volumeSpikeBuySidePct');
        if (volBuy && cfg.filters.volumeSpikeBuySidePct != null) {
          volBuy.value = cfg.filters.volumeSpikeBuySidePct;
        }
        const volMin = document.getElementById('volumeSpikeMinUsd');
        if (volMin && cfg.filters.volumeSpikeMinUsd != null) {
          volMin.value = cfg.filters.volumeSpikeMinUsd;
        }
        const volBoost = document.getElementById('volumeSpikeBoostPoints');
        if (volBoost && cfg.filters.volumeSpikeBoostPoints != null) {
          volBoost.value = cfg.filters.volumeSpikeBoostPoints;
        }
        const volHard = document.getElementById('volumeSpikeHardFilter');
        if (volHard) {
          volHard.checked = cfg.filters.volumeSpikeHardFilter !== false;
        }
        const confSens = document.getElementById('confirmationSensitivity');
        if (confSens && cfg.filters.confirmationSensitivity) {
          confSens.value = cfg.filters.confirmationSensitivity;
        }
        const confVolW = document.getElementById('confirmationVolumeWeight');
        if (confVolW && cfg.filters.confirmationVolumeWeight != null) {
          confVolW.value = cfg.filters.confirmationVolumeWeight;
        }
        const confSentW = document.getElementById('confirmationSentimentWeight');
        if (confSentW && cfg.filters.confirmationSentimentWeight != null) {
          confSentW.value = cfg.filters.confirmationSentimentWeight;
        }
        const confNarrW = document.getElementById('confirmationNarrativeWeight');
        if (confNarrW && cfg.filters.confirmationNarrativeWeight != null) {
          confNarrW.value = cfg.filters.confirmationNarrativeWeight;
        }
        const confBoost = document.getElementById('confirmationBoostPoints');
        if (confBoost && cfg.filters.confirmationBoostPoints != null) {
          confBoost.value = cfg.filters.confirmationBoostPoints;
        }
        const confHard = document.getElementById('confirmationHardFilter');
        if (confHard) {
          confHard.checked = cfg.filters.confirmationHardFilter === true;
        }
        for (const [id, key] of [
          ['marketSessionAllowAsia', 'marketSessionAllowAsia'],
          ['marketSessionAllowEurope', 'marketSessionAllowEurope'],
          ['marketSessionAllowUs', 'marketSessionAllowUs'],
          ['marketSessionAllowOverlap', 'marketSessionAllowOverlap'],
          ['marketSessionAllowOffHours', 'marketSessionAllowOffHours'],
        ]) {
          const el = document.getElementById(id);
          if (el) el.checked = cfg.filters[key] === true || (key !== 'marketSessionAllowOffHours' && cfg.filters[key] !== false);
        }
        const sessPref = document.getElementById('marketSessionPreferred');
        if (sessPref && Array.isArray(cfg.filters.marketSessionPreferred)) {
          sessPref.value = cfg.filters.marketSessionPreferred.join(',');
        }
        const sessBoost = document.getElementById('marketSessionPreferBoostPoints');
        if (sessBoost && cfg.filters.marketSessionPreferBoostPoints != null) {
          sessBoost.value = cfg.filters.marketSessionPreferBoostPoints;
        }
        if (cfg.strategy.migrationSizeMultiplier != null) {
          document.getElementById('migrationSizeMultiplier').value = cfg.strategy.migrationSizeMultiplier;
        }
        if (cfg.strategy.migrationSlippageBps != null) {
          document.getElementById('migrationSlippageBps').value = cfg.strategy.migrationSlippageBps;
        }
        const nearPct = document.getElementById('nearMigrationCurvePct');
        if (nearPct && cfg.strategy.nearMigrationCurvePct != null) {
          nearPct.value = cfg.strategy.nearMigrationCurvePct;
        }
        const earlyMax = document.getElementById('earlyCurveMaxPct');
        if (earlyMax && cfg.strategy.earlyCurveMaxPct != null) {
          earlyMax.value = cfg.strategy.earlyCurveMaxPct;
        }
        const minSm = document.getElementById('minEarlyBirdeyeSmartMoneyScore');
        if (minSm && cfg.strategy.minEarlyBirdeyeSmartMoneyScore != null) {
          minSm.value = cfg.strategy.minEarlyBirdeyeSmartMoneyScore;
        }
        const earlyW = document.getElementById('earlyCurveMinSmartWallets');
        if (earlyW && cfg.strategy.earlyCurveMinSmartWallets != null) {
          earlyW.value = cfg.strategy.earlyCurveMinSmartWallets;
        }
        const afterMaxEl = document.getElementById('reEntryAfterMaxProfitEnabled');
        if (afterMaxEl) afterMaxEl.checked = cfg.strategy.reEntryAfterMaxProfitEnabled === true;
        // Prefill Backtester filters from saved config (0 = inherit at run time)
        const btLiq = document.getElementById('bt-min-liq');
        const btVol = document.getElementById('bt-min-vol');
        const btRisk = document.getElementById('bt-max-risk');
        const btRebuy = document.getElementById('bt-rebuy');
        const btMig = document.getElementById('bt-mig-only');
        const btStart = document.getElementById('bt-start-bal');
        const btBanner = document.getElementById('bt-config-banner');
        if (btLiq && cfg.filters.minLiquidity != null) btLiq.value = cfg.filters.minLiquidity;
        if (btVol && cfg.filters.minVolume24hUsd != null) btVol.value = cfg.filters.minVolume24hUsd;
        if (btRisk && cfg.filters.maxRiskScore != null) btRisk.value = cfg.filters.maxRiskScore;
        if (btRebuy) btRebuy.checked = cfg.strategy.reBuyEnabled !== false;
        if (btMig) btMig.checked = !!cfg.strategy.enableMigrationOnly;
        if (btStart && cfg.paper && cfg.paper.startingBalanceSol != null) {
          btStart.value = cfg.paper.startingBalanceSol;
        }
        if (cfg.notifications) {
          const n = cfg.notifications;
          const setChk = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.checked = v === true;
          };
          const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null) el.value = v;
          };
          setChk('notify-enabled', n.enabled !== false);
          setVal('notify-email', n.email || 'isaacpascua87@gmail.com');
          setVal('notify-low-equity-sol', n.lowEquitySol != null ? n.lowEquitySol : 1);
          setChk('notify-low-equity', n.lowEquityEnabled !== false);
          setChk('notify-insufficient', n.insufficientFundsEnabled !== false);
          setChk('notify-profit-close', n.profitableCloseEnabled !== false);
        }
        const deliveryHint = document.getElementById('notify-delivery-hint');
        if (deliveryHint && cfg.emailDelivery) {
          const d = cfg.emailDelivery;
          deliveryHint.textContent = d.configured
            ? ('Delivery: ' + d.provider.toUpperCase() + ' ready → ' + (d.to || 'no recipient') +
              (d.from ? ' · from ' + d.from : '') +
              (d.hint ? ' · ' + d.hint : ''))
            : (d.hint || 'Set RESEND_API_KEY on Render (or SMTP_*) to deliver mail.');
          deliveryHint.style.color = d.configured ? '#34d399' : '#fbbf24';
        }
        syncBtMaxTradesFromRisk(cfg);
        if (btBanner) {
          const rl = (cfg.riskLevel || 'on').toUpperCase();
          const base = cfg.trade.baseTradeAmountSol ?? cfg.trade.tradeAmountSol;
          const preset = String(cfg.strategyProfile || 'custom').replace(/_/g, ' ');
          btBanner.textContent =
            'Live: ' + preset + ' preset · ' + rl + ' risk · base ' + base + ' SOL · SL ' +
            cfg.trade.stopLossPercent + '% · max profit ' + cfg.trade.maxProfitPercent +
            '% · Backtest / Live Sim inherit these gates. Overrides below are optional.';
        }
        // Strict Mode status
        updateStrictModeUI(cfg);
        if (cfg.strategy.reBuyMinProfitPct != null) {
          document.getElementById('reBuyMinProfitPct').value = cfg.strategy.reBuyMinProfitPct;
        }
        if (cfg.strategy.reBuyDipPercent != null) {
          document.getElementById('reBuyDipPercent').value = cfg.strategy.reBuyDipPercent;
        }
        if (cfg.strategy.confirmationThreshold != null) {
          document.getElementById('confirmationThreshold').value = cfg.strategy.confirmationThreshold;
        }
        if (cfg.strategy.reBuyVolumeIncreasePct != null) {
          document.getElementById('reBuyVolumeIncreasePct').value = cfg.strategy.reBuyVolumeIncreasePct;
        }
        const setNum = (id, v) => {
          const el = document.getElementById(id);
          if (el && v != null) el.value = v;
        };
        setNum('reEntryMaxPerMint', cfg.strategy.reEntryMaxPerMint ?? cfg.strategy.reBuyMaxPerMint);
        setNum('reEntryWatchMinutes', cfg.strategy.reEntryWatchMinutes);
        setNum('reEntryMinReclaimPct', cfg.strategy.reEntryMinReclaimPct);
        setNum('reEntryMinVolumeIncreasePct', cfg.strategy.reEntryMinVolumeIncreasePct ?? cfg.strategy.reBuyVolumeIncreasePct);
        setNum('reEntrySizeMultiplier', cfg.strategy.reEntrySizeMultiplier);
        setNum('reEntryCooldownMinutes', cfg.strategy.reEntryCooldownMinutes);
        if (cfg.risk) {
          document.getElementById('riskEnabled').checked = cfg.risk.enabled !== false;
          document.getElementById('tieredSellEnabled').checked = cfg.risk.tieredSellEnabled !== false;
          document.getElementById('autoPauseOnLimit').checked = cfg.risk.autoPauseOnLimit !== false;
          document.getElementById('riskPercentPerTrade').value = cfg.risk.riskPercentPerTrade;
          document.getElementById('trailingStopPct').value = cfg.risk.trailingStopPercent ?? cfg.risk.trailingStopPct;
          if (document.getElementById('trailingActivationProfit')) {
            document.getElementById('trailingActivationProfit').value = cfg.risk.trailingActivationProfit ?? 30;
          }
          document.getElementById('maxDrawdownPct').value = cfg.risk.maxDrawdownPct;
          document.getElementById('weeklyLossLimitSol').value = cfg.risk.weeklyLossLimitSol;
          document.getElementById('minTradeSol').value = cfg.risk.minTradeSol;
          document.getElementById('maxTradeSol').value = cfg.risk.maxTradeSol;
          document.getElementById('normalRiskPct').value = cfg.risk.normal.riskPercentPerTrade;
          document.getElementById('normalTrailPct').value = cfg.risk.normal.trailingStopPct;
          document.getElementById('migRiskPct').value = cfg.risk.migration.riskPercentPerTrade;
          document.getElementById('migTrailPct').value = cfg.risk.migration.trailingStopPct;
          if (document.getElementById('deadVolumeUsdPerHour')) {
            document.getElementById('deadVolumeUsdPerHour').value = cfg.risk.deadVolumeUsdPerHour ?? 50;
          }
          if (document.getElementById('deadVolumeConsecutiveHours')) {
            document.getElementById('deadVolumeConsecutiveHours').value = cfg.risk.deadVolumeConsecutiveHours ?? 3;
          }
          if (document.getElementById('deadVolumeMinHoldMinutes')) {
            document.getElementById('deadVolumeMinHoldMinutes').value = cfg.risk.deadVolumeMinHoldMinutes ?? 30;
          }
        }
        if (cfg.profitStrategy) {
          const ps = cfg.profitStrategy;
          const ra = document.getElementById('ps-risk-adjust');
          if (ra) ra.checked = ps.riskBasedAdjustment !== false;
          const setN = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null) el.value = v;
          };
          setN('ps-partial-at', ps.partialSellAt);
          setN('ps-partial-sell', ps.partialSellPercent);
          setN('ps-take-initial', ps.takeInitialPercent);
          setN('ps-bag', ps.bagPercent);
          setN('ps-trail-after', ps.trailingStopAfter);
          setN('ps-trail-pct', ps.trailingStopPct);
        }
        if (cfg.quickScalper) {
          const qs = cfg.quickScalper;
          const setN = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null) el.value = v;
          };
          setN('qs-time-limit', qs.timeLimitMinutes);
          setN('qs-take-profit', qs.takeProfitPct);
          setN('qs-stop-loss', qs.stopLossPct);
          setN('qs-min-volume', qs.minVolumeUsd);
          setN('qs-min-buy-pressure', qs.minBuyPressureUsd);
        }
        if (cfg.selective) {
          const sel = cfg.selective;
          const setChk = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.checked = v !== false;
          };
          setChk('sel-require-convergence', sel.requireConvergenceForNormal);
          setChk('sel-allow-single-mig', sel.allowSingleWalletMigration);
          const setN = (id, v) => {
            const el = document.getElementById(id);
            if (el && v != null) el.value = v;
          };
          setN('sel-min-conviction', sel.minConvictionScore);
          setN('sel-min-wallets', sel.minWalletsForTrade);
          setN('sel-max-per-hour', sel.maxTradesPerHour);
          setN('sel-cooldown-sec', Math.round((sel.minMsBetweenTrades ?? 0) / 1000));
          setN('sel-risk-cutoff', sel.riskScoreSizeCutoff);
          setN('sel-min-size-mult', sel.minRiskSizeMultiplier);
        }
        if (cfg.mev) {
          document.getElementById('useJitoBundles').checked = cfg.mev.useJitoBundles !== false;
          document.getElementById('sandwichProtection').checked = cfg.mev.sandwichProtection !== false;
          document.getElementById('abortOnSandwichRisk').checked = cfg.mev.abortOnSandwichRisk !== false;
          document.getElementById('tipMultiplier').value = cfg.mev.tipMultiplier;
          document.getElementById('priorityFeeMultiplier').value = cfg.mev.priorityFeeMultiplier;
          document.getElementById('sandwichMaxRecentBuys').value = cfg.mev.sandwichMaxRecentBuys;
        }
        if (cfg.rpc && status.jito) {
          document.getElementById('jitoTipLamports').value = status.jito.baseTipLamports || status.jito.tipLamports || 10000;
        }
      }

      const wtbody = document.querySelector('#wallets-table tbody');
      const scalpers = wallets.filter(w =>
        w.category === 'scalper' ||
        (w.tags && w.tags.some(t => /scalp/i.test(t))) ||
        (w.tradesLast7d != null && w.tradesLast7d >= 20)
      );
      const renderWalletRow = (w, cols) => \`
          <tr>
            <td>\${w.name}\${w.notes ? '<div class="mint">' + w.notes + '</div>' : ''}</td>
            \${cols > 7 ? '<td class="mint">' + (w.category || 'smart') + '</td>' : ''}
            <td>\${fmtWalletAddr(w.address)}</td>
            <td title="\${(w.lastActiveDisplay || '').replace(/"/g, '&quot;')}">\${fmtLastTraded(w.lastTradedAt || w.lastActive, w.daysSinceTrade, w.activityLabel)}</td>
            <td>\${w.winRate != null ? w.winRate.toFixed(0) + '%' : '—'}</td>
            \${cols > 7 ? '<td title="' + (w.qualityStatus || '') + '">' + (w.qualityScore != null ? w.qualityScore : '—') + '</td>' : ''}
            <td>\${w.tradesLast7d != null ? w.tradesLast7d : '—'} / \${w.tradesLast30d != null ? w.tradesLast30d : '—'}\${cols > 7 ? ' / ' + (w.pumpFunTradeCount != null ? w.pumpFunTradeCount : '—') : ''}</td>
            <td>\${w.enabled === false ? '⏸ Disabled' : (w.isActive ? '✅ ' + (w.activityLabel || 'Active') : '⛔ ' + (w.activityLabel || 'Inactive'))}\${w.qualityStatus ? '<div class="mint">' + w.qualityStatus + '</div>' : ''}</td>
            \${cols >= 9 ? '<td class="mint">' + (w.watching ? '👁 Yes' : '—') + '</td>' : ''}
            <td>
              <button class="secondary" onclick="toggleWallet('\${w.address}', \${!w.enabled})">\${w.enabled ? 'Disable' : 'Enable'}</button>
              <button class="danger" onclick="removeWallet('\${w.address}')">Remove</button>
            </td>
          </tr>\`;
      wtbody.innerHTML = wallets.length === 0
        ? '<tr><td colspan="10" style="color:var(--muted)">No wallets — search above or add one below</td></tr>'
        : wallets.slice(0, 200).map(w => renderWalletRow(w, 10)).join('') +
          (wallets.length > 200
            ? '<tr><td colspan="10" class="mint">Showing 200 of ' + wallets.length + ' wallets</td></tr>'
            : '');
      const stbody = document.querySelector('#scalper-wallets-table tbody');
      if (stbody) {
        stbody.innerHTML = scalpers.length === 0
          ? '<tr><td colspan="7" style="color:var(--muted)">No scalpers tracked yet</td></tr>'
          : scalpers.slice(0, 100).map(w => renderWalletRow(w, 7)).join('');
      }
      if (status.gmgn) updateDiscoveryUi(status.gmgn);
      else if (cfg && cfg.gmgn) updateDiscoveryUi(cfg.gmgn);

      const trailArmAt = (cfg && cfg.risk && cfg.risk.trailingActivationProfit != null)
        ? cfg.risk.trailingActivationProfit
        : 30;
      window._trailArmAt = trailArmAt;
      window._lastOpenPositions = positions.open || [];
      window._renderOpenPositionsHtml = function renderOpenPositionsHtml(list) {
        const armAt = window._trailArmAt != null ? window._trailArmAt : 30;
        if (!list || list.length === 0) {
          const pf = window._openProfileFilter || 'all';
          if (pf && pf !== 'all') {
            return '<tr><td colspan="15"><div class="positions-empty"><strong>No open positions for this profile</strong><span>Clear the profile filter or wait for a matching fill.</span></div></td></tr>';
          }
          return '<tr><td colspan="15"><div class="positions-empty"><strong>No open positions</strong><span>Live paper/live fills will appear here with PnL, trail, TP and SL.</span></div></td></tr>';
        }
        return list.map(p => {
          const prog = openPositionProgress(p);
          const pnlCell = fmtOpenPnlCell(p);
          let trailCell;
          if (p.trailingActive) {
            const stop = p.trailingStopPriceSol != null
              ? p.trailingStopPriceSol.toExponential(2)
              : '—';
            const peak = p.highWaterMarkSol != null
              ? p.highWaterMarkSol.toExponential(2)
              : '—';
            const tip = 'Trailing ACTIVE · ' + (p.trailingStopPct ?? '—') + '% from peak · stop ' + stop + ' · peak ' + peak;
            trailCell =
              '<span class="trail-cell-compact" style="color:var(--green)" title="' + tip.replace(/"/g, '&quot;') +
              '">ON ' + (p.trailingStopPct ?? '—') + '%</span>';
          } else {
            const tip = 'Trail off until +' + armAt + '% profit, then ' + (p.trailingStopPct ?? '—') + '% from peak';
            trailCell =
              '<span class="trail-cell-compact mint" title="' + tip.replace(/"/g, '&quot;') +
              '">+' + armAt + '% → ' + (p.trailingStopPct ?? '—') + '%</span>';
          }
          const ar = p.antiRug;
          const be = ar?.birdeye;
          const riskBits = [];
          const riskTips = [];
          if (ar) {
            riskBits.push('r' + ar.riskScore + (ar.flags && ar.flags[0] ? ' · ' + String(ar.flags[0]).slice(0, 18) : ''));
            riskTips.push('risk ' + ar.riskScore + (ar.flags && ar.flags[0] ? ' · ' + ar.flags[0] : ''));
          }
          if (p.convictionScore != null) {
            riskBits.push('c' + p.convictionScore);
            riskTips.push('conviction ' + p.convictionScore);
          }
          if (p.technicalLevels && p.technicalLevels.summary) {
            riskBits.push(String(p.technicalLevels.summary).slice(0, 22));
            riskTips.push(p.technicalLevels.summary);
          }
          if (be && (be.liquidityUsd != null || be.volume24hUsd != null)) {
            riskTips.push(
              'BE liq $' + (be.liquidityUsd != null ? Number(be.liquidityUsd).toFixed(0) : '?') +
              (be.volume24hUsd != null ? ' · vol $' + Number(be.volume24hUsd).toFixed(0) : '') +
              (be.smartMoneyScore != null ? ' · SM ' + be.smartMoneyScore : '')
            );
          }
          if (ar && (ar.liquidityUsd != null || ar.volume24hUsd != null || ar.holderCount != null)) {
            riskTips.push(
              'liq $' + (ar.liquidityUsd != null ? Number(ar.liquidityUsd).toFixed(0) : '?') +
              (ar.volume24hUsd != null ? ' · vol24h $' + Number(ar.volume24hUsd).toFixed(0) : '') +
              (ar.holderCount != null ? ' · holders ' + ar.holderCount : '')
            );
          }
          const riskBit = riskBits.length
            ? '<div class="pos-token-meta mint" title="' +
              escAttr(riskTips.join(' · ')) +
              '" style="color:' +
              (ar && (ar.riskLevel === 'high' || ar.riskLevel === 'critical') ? 'var(--red)' : 'var(--muted)') +
              '">' +
              escHtml(riskBits.join(' · ')) +
              '</div>'
            : '';
          const buyMc = fmtUsdShort(p.entryMarketCapUsd);
          const liveMc = fmtUsdShort(p.liveMarketCapUsd);
          const sellLabel = (p.symbol || p.mint.slice(0, 6)).replace(/'/g, "\\\\'");
          const costCell = fmtOpenSizeCell(p);
          const walletsCell = fmtWalletConvergence(p);
          const volCell = fmtVolH1(p.volumeH1Usd, p.txnsH1);
          const openedCell = fmtOpenedHoldCell(p.openedAt);
          const tokenCell = fmtOpenTokenCell(p, riskBit);
          const reasonCell = fmtOpenReasonCell(p);
          const tpSlCell =
            '<span class="pos-tpsl-cell" title="Take-profit / stop-loss">' +
            '+' +
            Number(p.takeProfitPct || 0).toFixed(0) +
            '% / ' +
            Number(p.stopLossPct || 0) +
            '%</span>';
          const rowClass = [
            prog.hasPartial ? 'pos-row-partial' : '',
            p.trailingActive ? 'pos-row-trail' : '',
          ].filter(Boolean).join(' ');
          return \`
          <tr class="\${rowClass}">
            <td>\${tokenCell}</td>
            <td>\${fmtTradeProfileBadge(p)}</td>
            <td>\${fmtTokenName(p.symbol, p.name, p.mint)}</td>
            <td>\${fmtMintCa(p.mint)}</td>
            <td class="mint" title="Market cap at your buy">\${buyMc}</td>
            <td class="mint" title="Current market cap (live mark)">\${liveMc}</td>
            <td class="pos-cost-cell" title="Original size and partial take-profit progress">\${costCell}</td>
            <td class="mint" title="Copied wallet — hover/tap for their entry MC">\${walletsCell}</td>
            <td>\${volCell}</td>
            <td>\${pnlCell}</td>
            <td>\${trailCell}</td>
            <td>\${tpSlCell}</td>
            <td>\${reasonCell}</td>
            <td>\${openedCell}</td>
            <td><button class="danger" onclick="forceSellPosition('\${p.id}', '\${sellLabel}')" title="Force sell entire position">Sell</button></td>
          </tr>\`;
        }).join('');
      };
      const posOpenN = (positions.open || []).length;
      ['sell-all-open', 'trades-sell-all-open'].forEach((id) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        if (posOpenN === 0) {
          btn.hidden = true;
          btn.disabled = true;
        } else {
          btn.hidden = false;
          btn.disabled = false;
        }
      });
      paintOpenPositionsTables();
      if (typeof renderZionOpenTrades === 'function') renderZionOpenTrades();

      window._closedTradeGroups = buildClosedTradeGroups(
        positions.closed || [],
        positions.open || []
      ).slice(0, 40);
      paintClosedTradesTables();

      const rb = positions.rebuy || {};
      const rbStatus = rb.status || status.monitor?.rebuy || {};
      const rbText =
        (rbStatus.enabled ? 'ON' : 'OFF') +
        ' · watching ' + (rbStatus.watching ?? 0) +
        (rbStatus.stopWatches != null ? ' · stop ' + rbStatus.stopWatches : '') +
        (rbStatus.profitWatches != null ? ' · dip ' + rbStatus.profitWatches : '') +
        ' · dip-armed ' + (rbStatus.dipArmed ?? 0) +
        ' · reclaim-armed ' + (rbStatus.reclaimArmed ?? 0) +
        ' · sells tracked ' + (rbStatus.sellHistoryCount ?? (positions.sellHistory || []).length);
      ['rebuy-status', 'trades-rebuy-status'].forEach((id) => {
        const rbEl = document.getElementById(id);
        if (rbEl) rbEl.textContent = rbText;
      });
      const rtbody = document.querySelector('#rebuy-table tbody');
      const candidates = rb.candidates || [];
      if (rtbody) {
        const fmtArmed = (c) => {
          const ts = c.reclaimArmedAt || c.dipArmedAt || c.createdAt;
          if (!ts) return '—';
          try { return fmtTimeAgoCell(ts); } catch (_) { return new Date(ts).toLocaleTimeString(); }
        };
        const fmtMove = (c) => {
          if (c.kind === 'stop_reentry') {
            return c.reclaimPctFromTrough != null
              ? ('+' + Number(c.reclaimPctFromTrough).toFixed(1) + '% reclaim')
              : '—';
          }
          return c.dipPctFromPeak != null
            ? (Number(c.dipPctFromPeak).toFixed(1) + '% dip')
            : '—';
        };
        const kindLabel = (c) =>
          c.kind === 'stop_reentry' ? 'stop' : (c.kind === 'profit_dip' ? 'dip' : (c.kind || '—'));
        rtbody.innerHTML = candidates.length === 0
          ? '<tr><td colspan="8" style="color:var(--muted)">No re-entry watches — stop-loss or profitable TP sells arm monitoring</td></tr>'
          : candidates.slice(0, 20).map(c => \`
            <tr>
              <td>\${fmtToken(c.symbol, c.name, c.mint)}</td>
              <td class="mint">\${kindLabel(c)}</td>
              <td>\${c.status}</td>
              <td>\${fmtMove(c)}</td>
              <td>\${(c.confirmationWallets || []).length}\${c.confirmationWalletNames?.length ? ' (' + c.confirmationWalletNames.slice(0,3).join(', ') + ')' : ''}</td>
              <td>\${c.volumeChangePct != null ? ((c.volumeChangePct>=0?'+':'') + c.volumeChangePct.toFixed(0) + '%') : '—'}</td>
              <td class="mint" title="\${escHtml(String((c.sell && c.sell.reason) || ''))}">\${fmtArmed(c)}</td>
              <td class="mint">\${escHtml(String(c.lastReason || (c.sell && c.sell.reason) || '—'))}</td>
            </tr>\`).join('');
      }

      const activityHtml = activity.length === 0
        ? '<div style="color:var(--muted)">No recent buys detected</div>'
        : activity.map(a => {
            const m = a.metrics || {};
            const ar = a.antiRug || {};
            const riskColor = ar.riskLevel === 'critical' || ar.riskLevel === 'high'
              ? 'var(--red)'
              : ar.riskLevel === 'medium' ? '#e6a817' : 'var(--green)';
            const riskBadge = ar.riskScore != null
              ? \` <span style="color:\${riskColor};font-weight:600">risk \${ar.riskScore}\${ar.riskLevel ? ' (' + ar.riskLevel + ')' : ''}</span>\`
              : '';
            const flagBits = (ar.flags || []).slice(0, 3).join(' · ');
            const bc = a.bondingCurve || {};
            const sn = a.sniper || a.antiRug || {};
            const be = a.birdeye || ar.birdeye || {};
            const beLiq = be.liquidityUsd != null ? Number(be.liquidityUsd) : (m.liquidityUsd != null ? Number(m.liquidityUsd) : (ar.liquidityUsd != null ? Number(ar.liquidityUsd) : null));
            const beVol = be.volume24hUsd != null ? Number(be.volume24hUsd) : (m.volume24hUsd != null ? Number(m.volume24hUsd) : (ar.volume24hUsd != null ? Number(ar.volume24hUsd) : null));
            const volH1 = m.volumeH1Usd != null ? Number(m.volumeH1Usd) : (ar.volumeH1Usd != null ? Number(ar.volumeH1Usd) : null);
            const beHold = be.holder != null ? Number(be.holder) : (m.holderCountEstimate != null ? Number(m.holderCountEstimate) : (ar.holderCount != null ? Number(ar.holderCount) : null));
            const beSm = be.smartMoneyScore != null ? Number(be.smartMoneyScore) : null;
            const curveHealth = bc.health || ar.curveHealth || null;
            const birdeyeBadge = (beLiq != null || beVol != null || beSm != null || volH1 != null || beHold != null)
              ? \` <span style="color:var(--muted)">liq $\${beLiq != null ? beLiq.toFixed(0) : '?'}\${beVol != null ? ' · vol24h $' + beVol.toFixed(0) : ''}\${volH1 != null ? ' · vol1h $' + volH1.toFixed(0) : ''}\${beHold != null ? ' · holders ' + beHold : ''}\${m.txnsH1 != null ? ' · txns1h ' + m.txnsH1 : ''}\${beSm != null ? ' · SM ' + beSm : ''}</span>\`
              : '';
            const curveBadge = bc.progressPct != null
              ? \` <span style="color:\${bc.nearMigration || curveHealth === 'preferred' ? 'var(--green)' : (curveHealth === 'dead' || curveHealth === 'stalled' ? 'var(--red)' : 'var(--muted)')};font-weight:600">curve \${Number(bc.progressPct).toFixed(0)}%\${curveHealth ? ' · ' + curveHealth : ''}\${bc.nearMigration ? ' · near-mig' : ''}\${bc.solRaised != null ? ' · ' + Number(bc.solRaised).toFixed(1) + ' SOL' : ''}</span>\`
              : '';
            const sniperBadge = (sn.sniperScore != null || sn.sniperCount != null)
              ? \` <span style="color:\${sn.highRisk || sn.sniperHighRisk ? 'var(--red)' : 'var(--muted)'}">sniper \${sn.sniperScore != null ? sn.sniperScore : '?'}\${sn.sniperCount != null ? ' · n=' + sn.sniperCount : ''}\${sn.bundlerPct != null ? ' · bundler ' + Number(sn.bundlerPct).toFixed(0) + '%' : ''}\${sn.insiderPct != null ? ' · insider ' + Number(sn.insiderPct).toFixed(0) + '%' : ''}</span>\`
              : '';
            const metricsLine = (m.liquidityUsd != null || m.devHoldPct != null || ar.riskScore != null || bc.progressPct != null || sn.sniperScore != null || beLiq != null || beVol != null || beHold != null)
              ? \` <span class="mint">liq $\${m.liquidityUsd != null ? Number(m.liquidityUsd).toFixed(0) : (beLiq != null ? beLiq.toFixed(0) : '?')} · vol24h $\${beVol != null ? beVol.toFixed(0) : '?'} · holders \${beHold != null ? beHold : '?'} · dev \${m.devHoldPct != null ? Number(m.devHoldPct).toFixed(1) + '%' : '?'} · top10 \${m.top10HoldPct != null ? Number(m.top10HoldPct).toFixed(0) + '%' : '?'}\${m.topHolderPct != null ? ' · top1 ' + Number(m.topHolderPct).toFixed(1) + '%' : ''}\${m.devActiveRecently ? ' · dev active' : ''}\${ar.honeypot ? ' · honeypot?' : ''}\${ar.recentDevSells ? ' · dev sells' : ''}\${ar.liquidityLockedOrBurned === true ? ' · LP locked' : ''}\${flagBits ? ' · ' + flagBits : ''}</span>\${birdeyeBadge}\${curveBadge}\${sniperBadge}\${riskBadge}\`
              : '';
            const skipBadge = a.skipReason
              ? \` <span style="color:var(--muted)">· \${a.tradeStatus === 'waiting' ? 'waiting' : 'skip'}: \${escHtml(String(a.skipReason).slice(0, 80))}</span>\`
              : (a.tradeStatus === 'taken' ? ' <span style="color:var(--green);font-weight:600">· taken</span>' : '');
            const seenAt = a.detectedAt || a.timestamp;
            const blockAge = a.timestamp ? (Date.now() - Number(a.timestamp)) : 0;
            const staleStyle = blockAge > 60 * 60 * 1000 ? 'opacity:0.72' : '';
            const ageNote = blockAge > 60 * 60 * 1000
              ? ' <span class="mint" title="On-chain buy time is older than 1h — shown for context">· on-chain \${fmtTimeAgoCell(a.timestamp)}</span>'
              : '';
            const entryBadge = fmtEntrySourceBadge({
              entrySource: a.entrySource,
              walletName: a.walletName,
              sourceNames: a.walletNames || a.sourceNames,
              reason: a.skipReason || a.reason,
            });
            return \`
          <div class="log-entry" style="\${staleStyle}">
            \${entryBadge ? entryBadge + ' ' : ''}<strong>\${escHtml(String(a.walletName || '—'))}</strong> bought
            \${fmtToken(a.symbol, a.name, a.mint)}
            \${a.name && a.name !== a.symbol ? '<span class="mint">(' + escHtml(a.name) + ')</span>' : ''}
            \${a.isMigration ? '🚀' : a.earlyBuy ? '🌱' : a.isPumpFun ? '🎯' : ''}
            \${a.earlyBuy && a.earlyBuyerCount ? '<span class="mint">early×' + a.earlyBuyerCount + '</span>' : ''}
            \${metricsLine}\${skipBadge}
            <span class="mint">\${a.mint ? fmtMintCa(a.mint) : ''} · seen \${fmtTimeAgoCell(seenAt)}</span>\${ageNote}
          </div>\`;
          }).join('');

      const actEl = document.getElementById('activity');
      if (actEl) actEl.innerHTML = activityHtml;
      const actSig = document.getElementById('activity-signals');
      if (actSig) actSig.innerHTML = activityHtml;
      const actTrades = document.getElementById('trades-activity');
      if (actTrades) actTrades.innerHTML = activityHtml;

      const scanStEls = document.querySelectorAll('[data-scanner-status]');
      const scanFeedEls = document.querySelectorAll('[data-scanner-feed]');
      if (scanStEls.length || scanFeedEls.length) {
        const ss = (scanner && scanner.status) || {};
        const cands = (scanner && scanner.candidates) || [];
        const statusText =
          (ss.enabled ? 'ON' : 'OFF') +
          (ss.running ? ' · polling' : '') +
          (ss.lastPollMs != null ? ' · last ' + ss.lastPollMs + 'ms' : '') +
          ' · ' + cands.length + ' recent' +
          (ss.degenRelaxed ? ' · degen-relaxed' : '') +
          (ss.regime && ss.regime.regime
            ? ' · regime ' + ss.regime.regime +
              (ss.regime.solChangeH1 != null
                ? ' (SOL h1 ' + Number(ss.regime.solChangeH1).toFixed(1) + '%)'
                : '')
            : '') +
          (Array.isArray(ss.skipBuckets) && ss.skipBuckets.length
            ? ' · skips: ' + ss.skipBuckets.slice(0, 3).map(function (b) {
                return String(b.reason || '').slice(0, 28) + '×' + b.count;
              }).join(', ')
            : '') +
          (ss.lastError ? ' · err: ' + ss.lastError : '');
        scanStEls.forEach(function (scanSt) {
          scanSt.textContent = statusText;
        });
        const feedHtml = cands.length === 0
          ? '<div class="mint text-xs">No scanner candidates yet — enable Market Scanner on the Scanner tab or Settings → Market Scanner (TA).</div>'
          : cands.slice(0, 25).map(function (c) {
              const migBadge = c.migrated
                ? '<span class="badge" style="background:#7c3aed;color:#fff;margin-right:0.35rem" title="Migration entry">Migration</span>'
                : '';
              const nameBit = c.name && c.name !== c.symbol
                ? ' <span class="mint">(' + escHtml(String(c.name)) + ')</span>'
                : '';
              const fmtChg = function (v) {
                if (v == null || !Number.isFinite(Number(v))) return null;
                const n = Number(v);
                return (n >= 0 ? '+' : '') + n.toFixed(0) + '%';
              };
              const chgH1 = fmtChg(c.priceChangeH1Pct);
              const chg24 = fmtChg(c.priceChangePct);
              const metricBits = [];
              if (c.liquidityUsd != null) metricBits.push('liq ' + fmtUsdShort(c.liquidityUsd));
              if (c.marketCapUsd != null) metricBits.push('MC ' + fmtUsdShort(c.marketCapUsd));
              if (c.volumeUsd != null) metricBits.push('vol24h ' + fmtUsdShort(c.volumeUsd));
              if (c.volumeH1Usd != null) metricBits.push('vol1h ' + fmtUsdShort(c.volumeH1Usd));
              if (c.holderCount != null) metricBits.push('holders ' + c.holderCount);
              if (chgH1 != null) metricBits.push('chg h1 ' + chgH1);
              if (chg24 != null) metricBits.push('chg 24h ' + chg24);
              if (c.playbook) metricBits.push(escHtml(String(c.playbook)));
              if (c.confluence != null) metricBits.push('conf ' + c.confluence);
              if (c.candleSource) metricBits.push(c.candleSource === 'real' ? 'real' : 'synthetic');
              metricBits.push('score ' + (c.rankScore != null ? c.rankScore : '—'));
              const reasonBits = (c.reasons || []).slice(0, 3).map(function (r) {
                return escHtml(String(r));
              }).join(' · ');
              if (reasonBits) metricBits.push(reasonBits);
              const metricsLine = metricBits.length
                ? ' <span class="mint">' + metricBits.join(' · ') + '</span>'
                : '';
              const skipBadge = c.skipReason
                ? ' <span style="color:var(--muted)">· skip: ' + escHtml(String(c.skipReason).slice(0, 80)) + '</span>'
                : (c.status === 'taken'
                  ? ' <span style="color:var(--green);font-weight:600">· taken</span>'
                  : (c.status === 'queued'
                    ? ' <span style="color:#60a5fa">· queued</span>'
                    : (c.status === 'skipped'
                      ? ' <span style="color:var(--muted)">· skipped</span>'
                      : '')));
              return (
                '<div class="log-entry">' +
                  '<span class="badge" style="background:#0d9488;color:#fff;margin-right:0.35rem" title="Market Scanner (TA)">Scanner</span>' +
                  migBadge +
                  fmtToken(c.symbol, c.name, c.mint) +
                  nameBit +
                  metricsLine +
                  skipBadge +
                  ' <span class="mint">' + (c.mint ? fmtMintCa(c.mint) : '') +
                  ' · seen ' + fmtTimeAgoCell(c.timestamp) + '</span>' +
                '</div>'
              );
            }).join('');
        scanFeedEls.forEach(function (scanFeed) {
          scanFeed.innerHTML = feedHtml;
        });
      }

      const sizingTbody = document.querySelector('#sizing-signals-table tbody');
      const sizingStatus = document.getElementById('sizing-status');
      const sizedSignals = (sized && sized.signals) || [];
      const st = sized && sized.trade ? sized.trade : (cfg.trade || {});
      if (sizingStatus) {
        sizingStatus.textContent =
          'Base ' + (st.baseTradeAmountSol ?? st.tradeAmountSol ?? '—') + ' SOL' +
          ' · risk×' + (st.riskMultiplier ?? '—') +
          ' · conviction×' + (st.convictionMultiplier ?? '—') +
          ' · ' + sizedSignals.length + ' recent';
      }
      if (sizingTbody) {
        sizingTbody.innerHTML = sizedSignals.length === 0
          ? '<tr><td colspan="7" class="text-slate-500">No sized signals yet</td></tr>'
          : sizedSignals.map(s => \`
            <tr>
              <td>\${fmtToken(s.symbol, s.name, s.mint)}</td>
              <td style="color:var(--accent,#60a5fa);font-weight:600">\${s.dynamicSizeSol != null ? Number(s.dynamicSizeSol).toFixed(4) : '—'}</td>
              <td>\${s.convictionScore != null ? s.convictionScore : '—'}</td>
              <td>\${s.riskScore != null ? s.riskScore : '—'}</td>
              <td style="color:\${s.accepted ? 'var(--green)' : 'var(--muted)'}">\${s.accepted ? 'taken' : 'skipped'}</td>
              <td class="mint" title="\${s.dynamicSizeReason || ''}">\${s.dynamicSizeReason || '—'}</td>
              <td class="mint">\${fmtTimeAgoCell(s.timestamp)}</td>
            </tr>\`).join('');
      }

      const prdSmStatus = document.getElementById('prd-sm-status');
      const prdSmTbody = document.querySelector('#prd-sm-table tbody');
      const dipSmCfg = (dipSm && dipSm.config) || {};
      const dipSmEvents = (dipSm && dipSm.events) || [];
      if (prdSmStatus) {
        prdSmStatus.textContent =
          (dipSmCfg.enabled ? 'Post-Run Dip ON' : 'Post-Run Dip OFF') +
          ' · SM sens ' + (dipSmCfg.sensitivity || 'medium') +
          ' · boost ≤' + (dipSmCfg.boostPoints != null ? dipSmCfg.boostPoints : 8) +
          (dipSmCfg.hardRequireSmartMoneyInConservative ? ' · Conservative hard-require' : '') +
          (dipSmCfg.requireSmartMoney ? ' · require SM' : '') +
          ' · ' + dipSmEvents.length + ' recent';
      }
      if (prdSmTbody) {
        prdSmTbody.innerHTML = dipSmEvents.length === 0
          ? '<tr><td colspan="9" class="text-slate-500">No dip smart-wallet events yet — enable Post-Run Dip</td></tr>'
          : dipSmEvents.map(e => {
            const outcomeColor =
              e.outcome === 'skip' || e.outcome === 'reject'
                ? 'var(--muted)'
                : e.influenced
                  ? 'var(--green)'
                  : 'var(--accent,#60a5fa)';
            return \`
            <tr>
              <td>\${escHtml(e.symbol || '—')}</td>
              <td style="color:\${outcomeColor};font-weight:600">\${escHtml(e.outcome || '—')}\${e.influenced ? ' · SM' : ''}</td>
              <td title="\${escHtml(e.detail || '')}">\${e.dipSmScore != null ? e.dipSmScore : '—'}\${e.dipSmStrong ? ' ★' : e.dipSmActive ? '' : ''}</td>
              <td>\${e.hqNewBuys != null ? e.hqNewBuys : '—'}</td>
              <td>\${e.buybacks != null ? e.buybacks : '—'}</td>
              <td>\${e.clusterNearLevel ? 'yes' : '—'}</td>
              <td>\${escHtml(e.netFlow || '—')}</td>
              <td class="mint" title="\${escHtml(e.logLine || e.detail || '')}">\${escHtml((e.detail || '').slice(0, 72))}</td>
              <td class="mint">\${fmtTimeAgoCell(e.timestamp)}</td>
            </tr>\`;
          }).join('');
      }

      ensurePosHoldTicker();
      tickOpenPositionHolds();

      const ps = status.monitor?.pumpSmart;
      const pumpStat = document.getElementById('pump-act-status');
      if (pumpStat && ps) {
        pumpStat.textContent =
          (ps.eventCount || 0) + ' events · ' +
          (ps.earlyBuys || 0) + ' early · ' +
          (ps.nearMigration || 0) + ' near-mig · ' +
          (ps.migrations || 0) + ' mig' +
          (ps.enableEarlyCurvePriority === false ? ' · early OFF' : '');
      }
      refreshPumpActivity().catch(() => {});

      const logHtml = (Array.isArray(logs) ? logs : []).map(l => \`
        <div class="log-entry log-\${l.type}" data-type="\${l.type}">\${fmtTimeAgoCell(l.timestamp)} — \${l.message}</div>\`).join('');
      const logsEl = document.getElementById('logs');
      if (logsEl) logsEl.innerHTML = logHtml || '<div class="text-slate-500 text-sm">No logs</div>';
      const logsFull = document.getElementById('logs-full');
      if (logsFull) logsFull.innerHTML = logHtml || '<div class="text-slate-500 text-sm">No logs</div>';
      if (typeof applyLogFilter === 'function') applyLogFilter();
      ensurePosHoldTicker();
      tickOpenPositionHolds();
      const overviewPanel = document.querySelector('[data-tab-panel="overview"]');
      const settingsPanel = document.querySelector('[data-tab-panel="settings"]');
      const microBotsPanel = document.querySelector('[data-tab-panel="microbots"]');
      if (
        (overviewPanel && !overviewPanel.classList.contains('hidden')) ||
        (settingsPanel && !settingsPanel.classList.contains('hidden')) ||
        (microBotsPanel && !microBotsPanel.classList.contains('hidden'))
      ) {
        loadLaneDecisions().catch(function () {});
      }
      } catch (err) {
        console.error('[dashboard] refresh failed:', err);
        const detail = document.getElementById('stat-detail');
        if (detail) {
          detail.textContent = 'Refresh error: ' + ((err && err.message) || String(err));
        }
      } finally {
        window._refreshInFlight = false;
      }
    }

    async function setMode(mode) {
      if (mode === 'live' && !confirm('Switch to LIVE trading? Real funds will be used with the selected trading wallet.')) return;
      if (mode === 'liveSimulation' && !confirm('Switch to LIVE SIMULATION? Uses live market data and the same filters as live, but fills stay virtual — no real funds.')) return;
      try {
        await fetchJSON('/api/config/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
        await refresh();
        loadTradingWallets();
        refreshPerformanceCompare();
      } catch (err) {
        alert(err.message);
      }
    }

    function renderScoreCard(prefix, score) {
      const gradeEl = document.getElementById(prefix + '-score-grade');
      const numEl = document.getElementById(prefix + '-score-num');
      const subEl = document.getElementById(prefix + '-score-sub');
      if (!gradeEl || !numEl) return;
      if (!score || score.score == null) {
        gradeEl.textContent = '—';
        numEl.textContent = '—';
        gradeEl.className = 'score-grade score-tone-neutral';
        numEl.className = 'score-num score-tone-neutral';
        if (subEl) subEl.textContent = 'No closed trades yet';
        return;
      }
      const tone = score.tone || 'neutral';
      gradeEl.textContent = score.grade || '—';
      numEl.textContent = (score.score != null ? score.score : '—') + '/100';
      gradeEl.className = 'score-grade score-tone-' + tone;
      numEl.className = 'score-num score-tone-' + tone;
      if (subEl) subEl.textContent = score.label || '';
    }

    function fmtCmpVal(key, v) {
      if (v == null || !Number.isFinite(Number(v))) return '—';
      const n = Number(v);
      if (key === 'winRatePct' || key === 'maxDrawdownPct') return n.toFixed(1) + '%';
      if (key === 'netPnlSol') return (n >= 0 ? '+' : '') + n.toFixed(4);
      if (key === 'avgHoldSec') {
        if (n < 60) return Math.round(n) + 's';
        if (n < 3600) return (n / 60).toFixed(1) + 'm';
        return (n / 3600).toFixed(1) + 'h';
      }
      if (key === 'profitFactor') return n >= 999 ? '∞' : n.toFixed(2);
      if (key === 'closedTrades' || key === 'score') return String(Math.round(n));
      return n.toFixed(2);
    }

    function metricLabel(key) {
      return ({
        winRatePct: 'Win Rate',
        profitFactor: 'Profit Factor',
        netPnlSol: 'Total PnL (SOL)',
        maxDrawdownPct: 'Max Drawdown',
        closedTrades: 'Closed Trades',
        avgHoldSec: 'Avg Hold',
        score: 'Perf Score',
      })[key] || key;
    }

    function fillCompareTable(tbodyId, winnerId, data) {
      const table = document.getElementById(tbodyId);
      const tbody = table ? (table.querySelector('tbody') || table) : null;
      const winnerEl = document.getElementById(winnerId);
      if (!tbody) return;
      const metrics = (data && data.metrics) || [];
      if (!metrics.length) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-slate-500">No comparison data</td></tr>';
        if (winnerEl) winnerEl.textContent = '—';
        return;
      }
      tbody.innerHTML = metrics.map(m => {
        const edge =
          m.winner === 'liveSim' ? '<span class="cmp-win">Live Sim</span>' :
          m.winner === 'backtest' ? '<span class="cmp-win">Backtest</span>' :
          m.winner === 'tie' ? '<span class="cmp-tie">Tie</span>' : '—';
        return '<tr><td>' + metricLabel(m.key) + '</td><td>' + fmtCmpVal(m.key, m.liveSim) +
          '</td><td>' + fmtCmpVal(m.key, m.backtest) + '</td><td>' + edge + '</td></tr>';
      }).join('');
      if (winnerEl) {
        const w = data.overallWinner;
        winnerEl.textContent =
          w === 'liveSim' ? 'Overall edge: Live Simulation' :
          w === 'backtest' ? 'Overall edge: Backtest' :
          w === 'tie' ? 'Overall: roughly tied' : '—';
      }
    }

    let chartBtOverlayEquity = null;
    let chartBtCompareBars = null;

    function upsertLineChart(existing, canvasId, labels, datasets) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || typeof Chart === 'undefined') return existing;
      if (!existing) {
        return new Chart(canvas, {
          type: 'line',
          data: { labels: labels || [], datasets: datasets || [] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
              legend: { labels: { color: '#94a3b8', boxWidth: 12 } },
              tooltip: { callbacks: { label: (c) => (c.dataset.label || '') + ': ' + Number(c.raw).toFixed(4) } },
            },
            scales: {
              x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: '#1e293b' } },
              y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
            },
          },
        });
      }
      existing.data.labels = labels || [];
      existing.data.datasets = datasets || [];
      existing.update('none');
      return existing;
    }

    function upsertBarChart(existing, canvasId, labels, datasets) {
      const canvas = document.getElementById(canvasId);
      if (!canvas || typeof Chart === 'undefined') return existing;
      if (!existing) {
        return new Chart(canvas, {
          type: 'bar',
          data: { labels: labels || [], datasets: datasets || [] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { labels: { color: '#94a3b8', boxWidth: 12 } },
              tooltip: { callbacks: { label: (c) => (c.dataset.label || '') + ': ' + Number(c.raw).toFixed(2) } },
            },
            scales: {
              x: { ticks: { color: '#94a3b8' }, grid: { display: false } },
              y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' }, beginAtZero: true },
            },
          },
        });
      }
      existing.data.labels = labels || [];
      existing.data.datasets = datasets || [];
      existing.update('none');
      return existing;
    }

    async function refreshPerformanceCompare() {
      try {
        const data = await fetchJSON('/api/performance/compare');
        fillCompareTable('bt-perf-compare-table', 'bt-perf-compare-winner', data);

        const liveEq = (data.liveSim && data.liveSim.charts && data.liveSim.charts.cumulativePnl) || {};
        const btEq = (data.backtest && data.backtest.charts && (data.backtest.charts.equityCurve || data.backtest.charts.cumulativePnl)) || {};
        const liveVals = liveEq.values || [];
        const btVals = (btEq.values || []).map((v, i, arr) => {
          const start = arr[0] != null ? arr[0] : 0;
          return Number(v) - Number(start);
        });
        const liveNorm = liveVals.map((v, i, arr) => Number(v) - Number(arr[0] || 0));
        const n = Math.max(liveNorm.length, btVals.length, 1);
        const labels = Array.from({ length: n }, (_, i) => String(i + 1));
        const pad = (arr) => {
          const out = arr.slice();
          while (out.length < n) out.push(null);
          return out;
        };
        const overlayDatasets = [
          {
            label: 'Live Sim',
            data: pad(liveNorm),
            borderColor: '#5eead4',
            backgroundColor: '#5eead433',
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            spanGaps: true,
          },
          {
            label: 'Backtest',
            data: pad(btVals),
            borderColor: '#93c5fd',
            backgroundColor: '#93c5fd33',
            tension: 0.25,
            fill: false,
            pointRadius: 0,
            spanGaps: true,
          },
        ];
        chartBtOverlayEquity = upsertLineChart(chartBtOverlayEquity, 'bt-chart-overlay-equity', labels, overlayDatasets);
        const ovEmpty = document.getElementById('bt-chart-overlay-empty');
        if (ovEmpty) ovEmpty.style.display = (liveNorm.length || btVals.length) ? 'none' : '';

        const metrics = data.metrics || [];
        const barKeys = ['winRatePct', 'profitFactor', 'maxDrawdownPct', 'score'];
        const barLabels = barKeys.map(metricLabel);
        const liveBars = barKeys.map(k => {
          const m = metrics.find(x => x.key === k);
          return m && m.liveSim != null ? Number(m.liveSim) : 0;
        });
        const btBars = barKeys.map(k => {
          const m = metrics.find(x => x.key === k);
          return m && m.backtest != null ? Number(m.backtest) : 0;
        });
        const barDatasets = [
          { label: 'Live Sim', data: liveBars, backgroundColor: '#2dd4bf88', borderColor: '#5eead4', borderWidth: 1 },
          { label: 'Backtest', data: btBars, backgroundColor: '#60a5fa88', borderColor: '#93c5fd', borderWidth: 1 },
        ];
        chartBtCompareBars = upsertBarChart(chartBtCompareBars, 'bt-chart-compare-bars', barLabels, barDatasets);
        const cmpEmpty = document.getElementById('bt-chart-compare-empty');
        if (cmpEmpty) cmpEmpty.style.display = data.backtest ? 'none' : '';

        // Live-sim ledger score for the compare card subtitle (does not overwrite backtest grade)
        if (data.liveSim && data.liveSim.score) {
          const sub = document.getElementById('bt-score-sub');
          if (sub && !window._lastBacktest) {
            sub.textContent = 'Live Sim score available — run a backtest';
          }
        }
      } catch (err) {
        console.warn('[dashboard] performance compare failed', err);
      }
    }

    // Risk-level max concurrent positions (RISK_LEVEL_PRESETS.filters.maxConcurrentPositions)
    // Synced into BT "Max concurrent" — NOT a total-trade budget for the lookback.
    const BT_RISK_MAX_TRADES = { on: 12, off: 40 };

    function btMaxTradesForRiskLevel(level, cfg) {
      const key = String(level || 'current').toLowerCase();
      if (key === 'on' || key === 'off') {
        return BT_RISK_MAX_TRADES[key];
      }
      const live =
        (cfg && cfg.filters && cfg.filters.maxConcurrentPositions) ||
        (cfg && cfg.riskLevelSummary && cfg.riskLevelSummary.active &&
          cfg.riskLevelSummary.active.maxConcurrentPositions) ||
        (_lastConfig && _lastConfig.filters && _lastConfig.filters.maxConcurrentPositions) ||
        BT_RISK_MAX_TRADES[String((cfg && cfg.riskLevel) || (_lastConfig && _lastConfig.riskLevel) || 'on')] ||
        12;
      return Math.max(1, Math.min(80, Number(live) || 12));
    }

    function syncBtMaxTradesFromRisk(cfg) {
      const riskSel = document.getElementById('bt-risk-level');
      const maxEl = document.getElementById('bt-max');
      if (!maxEl) return;
      const level = (riskSel && riskSel.value) || 'current';
      maxEl.value = String(btMaxTradesForRiskLevel(level, cfg || _lastConfig));
    }

    function onBtRiskLevelChange() {
      syncBtMaxTradesFromRisk(_lastConfig);
    }

    function btStrictIsActive(_mode, _cfg) {
      return false;
    }

    function onBtStrictModeChange() {
      /* Strict Mode UI removed */
    }

    function btStrictPayload() {
      return {};
    }

    async function runBacktestMatchingLive() {
      const riskSel = document.getElementById('bt-risk-level');
      if (riskSel) riskSel.value = 'current';
      syncBtMaxTradesFromRisk(_lastConfig);
      showTab('backtester');
      await runBacktest({ matchLiveStrict: true });
    }

    async function loadTradingWallets() {
      const statusEl = document.getElementById('live-wallet-status');
      try {
        const data = await fetchJSON('/api/trading-wallets');
        const tbody = document.querySelector('#trading-wallets-table tbody');
        tbody.innerHTML = (data.wallets || []).length === 0
          ? '<tr><td colspan="7" style="color:var(--muted)">No trading wallet slots</td></tr>'
          : data.wallets.map(w => \`
            <tr style="\${w.isActive ? 'outline:1px solid var(--accent, #3b82f6)' : ''}">
              <td><strong>\${w.name}</strong>\${w.isActive ? ' <span class="mint">(active)</span>' : ''}</td>
              <td>\${w.role}</td>
              <td class="mint">\${w.envVar}</td>
              <td class="mint" title="\${w.publicKey || ''}">\${w.publicKey ? w.publicKey.slice(0,8) + '…' + w.publicKey.slice(-4) : '—'}</td>
              <td>\${w.balanceSol != null ? w.balanceSol.toFixed(4) : '—'}</td>
              <td>\${w.hasKey ? '✅' : '❌ missing'}</td>
              <td>
                \${w.isActive
                  ? '<span class="mint">Selected</span>'
                  : \`<button onclick="selectTradingWallet('\${w.id}')">Use for live</button>\`}
                \${w.role === 'main' ? '' : \`<button class="danger" onclick="removeTradingWalletSlot('\${w.id}')">Remove</button>\`}
              </td>
            </tr>\`).join('');
        if (statusEl) {
          const active = (data.wallets || []).find(w => w.isActive);
          statusEl.textContent = active
            ? 'Active: ' + active.name + (active.hasKey ? '' : ' — set ' + active.envVar + ' in .env')
            : 'No active wallet';
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message;
      }
    }

    async function selectTradingWallet(id) {
      try {
        const data = await fetchJSON('/api/trading-wallets/select', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!data.hasKey) {
          alert('Selected, but no key loaded — add the env var in .env and restart the bot.');
        }
        await loadTradingWallets();
        refresh();
      } catch (err) {
        alert(err.message);
      }
    }

    async function removeTradingWalletSlot(id) {
      if (!confirm('Remove this trading wallet slot? (Does not delete your .env key)')) return;
      try {
        await fetchJSON('/api/trading-wallets/' + encodeURIComponent(id), { method: 'DELETE' });
        await loadTradingWallets();
      } catch (err) {
        alert(err.message);
      }
    }

    async function togglePause() {
      await fetchJSON('/api/monitor/toggle', { method: 'POST' });
      refresh();
    }

    async function forceRefreshMonitoring() {
      const st = document.getElementById('gmgn-status') || document.getElementById('watched-sub');
      if (st) st.textContent = 'Force refreshing monitoring…';
      try {
        const data = await fetchJSON('/api/monitor/force-refresh', { method: 'POST' });
        if (st) {
          st.textContent =
            data.message ||
            ('Watching ' + (data.watching ?? 0) + '/' + (data.tracked ?? 0));
        }
        alert(
          data.message ||
            ('Now watching ' + (data.watching ?? 0) + ' of ' + (data.tracked ?? 0) + ' wallets')
        );
        await refresh();
      } catch (err) {
        if (st) st.textContent = 'Force refresh failed: ' + (err.message || err);
        alert('Force refresh failed: ' + (err.message || err));
      }
    }

    async function saveTradeConfig(silent) {
      const body = {};
      ['tradeAmountSol','maxAllowedTradeSol','riskMultiplier','convictionMultiplier','minProfitPercent','maxProfitPercent','stopLossPercent'].forEach(k => {
        body[k] = Number(document.getElementById(k).value);
      });
      body.baseTradeAmountSol = body.tradeAmountSol;
      await fetchJSON('/api/config/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!silent) alert('Trade settings saved');
    }

    async function saveFilterConfig(silent) {
      const checked = (id, fallback) => {
        const el = document.getElementById(id);
        return el ? el.checked : fallback;
      };
      const body = {
        skipIfMintAuthority: checked('skipIfMintAuthority', false),
        checkHoneypot: checked('checkHoneypot', true),
        skipIfDevRecentSells: checked('skipIfDevRecentSells', true),
        requireLiquidityLocked: checked('requireLiquidityLocked', false),
        enableWalletQualityGate: checked('enableWalletQualityGate', true),
        enableWalletQualityAutoPrune: checked('enableWalletQualityAutoPrune', false),
        enableEntryTimingGate: checked('enableEntryTimingGate', true),
        allowSingleWalletTopPerformerMigration: checked('allowSingleWalletTopPerformerMigration', true),
        requireMomentumConfirmation: checked('requireMomentumConfirmation', false),
        requireHealthyCurve: checked('requireHealthyCurve', false),
        requireRecentCurveActivity: checked('requireRecentCurveActivity', true),
        sniperSensitivity: document.getElementById('sniperSensitivity')
          ? document.getElementById('sniperSensitivity').value
          : 'medium',
        socialSentimentSensitivity: document.getElementById('socialSentimentSensitivity')
          ? document.getElementById('socialSentimentSensitivity').value
          : 'medium',
        trendingNarrativeSensitivity: document.getElementById('trendingNarrativeSensitivity')
          ? document.getElementById('trendingNarrativeSensitivity').value
          : 'medium',
        trendingNarrativeBoostPoints: document.getElementById('trendingNarrativeBoostPoints')
          ? Number(document.getElementById('trendingNarrativeBoostPoints').value)
          : 6,
        volumeSpikeSensitivity: document.getElementById('volumeSpikeSensitivity')
          ? document.getElementById('volumeSpikeSensitivity').value
          : 'medium',
        volumeSpikeHardFilter: document.getElementById('volumeSpikeHardFilter')
          ? document.getElementById('volumeSpikeHardFilter').checked
          : true,
        volumeSpikeWindowMinutes: document.getElementById('volumeSpikeWindowMinutes')
          ? Number(document.getElementById('volumeSpikeWindowMinutes').value)
          : 3,
        volumeSpikeMultiplier: document.getElementById('volumeSpikeMultiplier')
          ? Number(document.getElementById('volumeSpikeMultiplier').value)
          : 3,
        volumeSpikeBuySidePct: document.getElementById('volumeSpikeBuySidePct')
          ? Number(document.getElementById('volumeSpikeBuySidePct').value)
          : 65,
        volumeSpikeMinUsd: document.getElementById('volumeSpikeMinUsd')
          ? Number(document.getElementById('volumeSpikeMinUsd').value)
          : 2500,
        volumeSpikeBoostPoints: document.getElementById('volumeSpikeBoostPoints')
          ? Number(document.getElementById('volumeSpikeBoostPoints').value)
          : 8,
        confirmationSensitivity: document.getElementById('confirmationSensitivity')
          ? document.getElementById('confirmationSensitivity').value
          : 'medium',
        confirmationHardFilter: document.getElementById('confirmationHardFilter')
          ? document.getElementById('confirmationHardFilter').checked
          : false,
        confirmationVolumeWeight: document.getElementById('confirmationVolumeWeight')
          ? Number(document.getElementById('confirmationVolumeWeight').value)
          : 50,
        confirmationSentimentWeight: document.getElementById('confirmationSentimentWeight')
          ? Number(document.getElementById('confirmationSentimentWeight').value)
          : 25,
        confirmationNarrativeWeight: document.getElementById('confirmationNarrativeWeight')
          ? Number(document.getElementById('confirmationNarrativeWeight').value)
          : 25,
        confirmationBoostPoints: document.getElementById('confirmationBoostPoints')
          ? Number(document.getElementById('confirmationBoostPoints').value)
          : 10,
        marketSessionAllowAsia: document.getElementById('marketSessionAllowAsia')
          ? document.getElementById('marketSessionAllowAsia').checked
          : true,
        marketSessionAllowEurope: document.getElementById('marketSessionAllowEurope')
          ? document.getElementById('marketSessionAllowEurope').checked
          : true,
        marketSessionAllowUs: document.getElementById('marketSessionAllowUs')
          ? document.getElementById('marketSessionAllowUs').checked
          : true,
        marketSessionAllowOverlap: document.getElementById('marketSessionAllowOverlap')
          ? document.getElementById('marketSessionAllowOverlap').checked
          : true,
        marketSessionAllowOffHours: document.getElementById('marketSessionAllowOffHours')
          ? document.getElementById('marketSessionAllowOffHours').checked
          : false,
        marketSessionPreferred: document.getElementById('marketSessionPreferred')
          ? document.getElementById('marketSessionPreferred').value
          : 'us,europe_us,europe',
        marketSessionPreferBoostPoints: document.getElementById('marketSessionPreferBoostPoints')
          ? Number(document.getElementById('marketSessionPreferBoostPoints').value)
          : 3,
        buyPumpFunOnly: document.getElementById('buyPumpFunOnly')
          ? document.getElementById('buyPumpFunOnly').checked
          : true,
      };
      ['convergenceRequired','maxConcurrentPositions','dailyLossLimitSol','minWinRate','minLiquidity','minMarketCapUsd',
       'minDevHoldPct','maxDevHoldPct','minTopHolderPct','maxTopHolderPct','maxHolderConcentration','minTop10HolderPct',
       'minRiskScore','maxRiskScore','minEstimatedTaxPct','maxEstimatedTaxPct',
       'minActivityDays','minTradesLast30d','minVolume24hUsd','minRecentVolumeUsd','minRecentBuyVolumeUsd',
       'minHolders','minRecentActivity','minWalletQualityScore','walletQualityInactiveDays','maxEntryAgeMinutes',
       'preferEntryWithinMinutes','clusterMinWallets','clusterWindowMinutes','smartMoneyFlowWeight',
       'momentumLookbackMinutes','momentumMinHoldPct','maxSniperCount','maxBundlerPct','maxSniperScore',
       'minCurveProgress','maxCurveProgressForEntry'].forEach(k => {
        const el = document.getElementById(k);
        if (el) body[k] = Number(el.value);
      });
      body.maxDevPercent = body.maxDevHoldPct;
      body.minHolderCount = body.minHolders;
      await fetchJSON('/api/config/filters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!silent) alert('Filters saved');
    }

    async function saveSelectiveConfig(silent) {
      await fetchJSON('/api/config/selective', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requireConvergenceForNormal: document.getElementById('sel-require-convergence').checked,
          allowSingleWalletMigration: document.getElementById('sel-allow-single-mig').checked,
          minConvictionScore: Number(document.getElementById('sel-min-conviction').value),
          minWalletsForTrade: Number(document.getElementById('sel-min-wallets').value),
          maxTradesPerHour: Number(document.getElementById('sel-max-per-hour').value),
          minMsBetweenTrades: Number(document.getElementById('sel-cooldown-sec').value) * 1000,
          riskScoreSizeCutoff: Number(document.getElementById('sel-risk-cutoff').value),
          minRiskSizeMultiplier: Number(document.getElementById('sel-min-size-mult').value),
        }),
      });
      if (!silent) alert('Selective trading settings saved');
    }

    function onDiscoverSourceChange() {
      const source = (document.getElementById('discover-source') || {}).value;
      const box = document.getElementById('discover-manual-box');
      if (box) box.style.opacity = source === 'manual' ? '1' : '0.95';
    }

    const HIGH_FREQ_TRADE_LIMIT = 1000;

    function walletTradeCounts(w) {
      const trades7d = w.tradesLast7d != null
        ? w.tradesLast7d
        : (w.metrics && w.metrics.trades7d != null ? w.metrics.trades7d : null);
      const trades30d = w.tradesLast30d != null
        ? w.tradesLast30d
        : (w.metrics && w.metrics.trades30d != null ? w.metrics.trades30d : null);
      return { trades7d, trades30d };
    }

    function isHighFrequencyWallet(w) {
      const { trades7d, trades30d } = walletTradeCounts(w);
      return (trades7d != null && trades7d > HIGH_FREQ_TRADE_LIMIT)
        || (trades30d != null && trades30d > HIGH_FREQ_TRADE_LIMIT);
    }

    function excludeHighFrequencyEnabled() {
      return !!(document.getElementById('discover-exclude-hf') || {}).checked;
    }

    function filterHighFrequencyWallets(rows) {
      if (!excludeHighFrequencyEnabled() || !rows || !rows.length) return rows || [];
      return rows.filter(w => !isHighFrequencyWallet(w));
    }

    function fmtLastTrade(ts) {
      if (!ts) return '—';
      const s = Math.max(0, (Date.now() - Number(ts)) / 1000);
      if (s < 60) return Math.round(s) + 's ago';
      if (s < 3600) return Math.round(s / 60) + 'm ago';
      if (s < 86400) return Math.round(s / 3600) + 'h ago';
      return Math.round(s / 86400) + 'd ago';
    }

    async function discoverWallets(force) {
      const status = document.getElementById('discover-status');
      const keyEl = document.getElementById('discover-key-status');
      const related = document.getElementById('discover-related');
      const empty = document.getElementById('discover-empty');
      const emptyMsg = document.getElementById('discover-empty-msg');
      const source = document.getElementById('discover-source').value;
      const period = document.getElementById('discover-period').value;
      const limit = Number((document.getElementById('discover-limit') || {}).value || 100);
      const minWinRate = Number((document.getElementById('discover-min-wr') || {}).value || 35);
      const preferScalpers = !!(document.getElementById('discover-scalpers') || {}).checked;
      const pumpFunFocus = !!(document.getElementById('discover-pump') || {}).checked;
      if (empty) empty.classList.add('hidden');
      status.textContent = 'Discovering via ' + source + ' (limit ' + limit + ')…';
      try {
        let data;
        if (source === 'pump') {
          data = await fetchJSON('/api/discover-pump-smart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit, force: !!force }),
            timeoutMs: 60000,
          });
        } else {
          const body = {
            source,
            period,
            limit,
            minWinRate,
            force: !!force,
            defaultSource: source === 'all' || source === 'kolscan' || source === 'bullx' || source === 'pump' ? 'gmgn' : source,
            pumpFunFocus,
          };
          if (source === 'manual') {
            body.manualText = (document.getElementById('discover-manual-text') || {}).value || '';
          }
          data = await fetchJSON('/api/discover-wallets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            timeoutMs: 25000,
          });
        }
        let rows = data.wallets || [];
        rows = filterHighFrequencyWallets(rows);
        if (preferScalpers) {
          rows = rows.slice().sort((a, b) => {
            const aS = (a.tradesLast7d || a.tradeCount || 0) >= 20 ? 1 : 0;
            const bS = (b.tradesLast7d || b.tradeCount || 0) >= 20 ? 1 : 0;
            if (bS !== aS) return bS - aS;
            return (b.tradesLast7d || 0) - (a.tradesLast7d || 0);
          });
        }
        window._discoveredWallets = rows;
        window._topWallets = rows.map(w => ({
          name: w.name,
          address: w.address,
          winRate: w.winRate,
          lastActiveAt: w.lastActiveAt,
          tradesLast7d: w.tradesLast7d,
          tradesLast30d: w.tradesLast30d,
          pumpFunTradeCount: w.pumpFunTradeCount != null
            ? w.pumpFunTradeCount
            : (w.metrics && w.metrics.pumpFunTrades != null ? w.metrics.pumpFunTrades : undefined),
          tags: w.tags,
          notes: w.notes,
          alreadyTracked: w.alreadyTracked,
          realizedPnlUsd: w.realizedPnlUsd,
          source: w.source,
        }));
        status.textContent =
          (data.message || data.source) +
          (data.cached ? ' (cache)' : '') +
          ' · ' + rows.length + ' wallets' +
          (data.error ? ' · ' + data.error : '');
        if (keyEl) {
          const hasBird = data.discovery && data.discovery.hasBirdeyeKey;
          const hasSt = data.discovery && data.discovery.hasSolanaTrackerKey;
          if (source === 'axiom' || source === 'photon') {
            keyEl.textContent = hasSt
              ? 'Solana Tracker key ✓'
              : 'Set SOLANA_TRACKER_API_KEY for Axiom/Photon leaderboards';
          } else if (source === 'bullx') {
            keyEl.textContent = 'BullX Neo offline — use Axiom or Photon instead';
          } else if (source === 'birdeye') {
            keyEl.textContent = hasBird
              ? 'Birdeye key ✓'
              : 'No Birdeye key — using fallbacks';
          } else {
            keyEl.textContent = hasBird
              ? 'Birdeye key ✓' + (hasSt ? ' · Tracker ✓' : '')
              : (hasSt
                  ? 'Solana Tracker ✓ · GMGN may be CF-blocked · Kolscan OK'
                  : 'GMGN may be CF-blocked · Kolscan/curated OK · add SOLANA_TRACKER_API_KEY for Axiom/Photon');
          }
        }
        if (related) {
          const toks = data.relatedTokens || data.hotLaunches || [];
          related.textContent = toks.length
            ? 'Hot: ' + toks.slice(0, 6).map(t => t.symbol + (t.volumeUsd || t.volume24hUsd ? ' $' + Math.round(t.volumeUsd || t.volume24hUsd).toLocaleString() : '') + (t.progressPct != null ? ' · ' + Number(t.progressPct).toFixed(0) + '%' : '')).join(' · ')
            : '';
        }
        const tbody = document.querySelector('#discover-wallets-table tbody');
        if (rows.length === 0) {
          if (empty) empty.classList.remove('hidden');
          if (emptyMsg) emptyMsg.textContent = data.error || data.message || 'No candidates returned from this source.';
          tbody.innerHTML = '<tr><td colspan="10" style="color:var(--muted)">No wallets found — see tips above</td></tr>';
        } else {
          if (empty) empty.classList.add('hidden');
          tbody.innerHTML = rows.map(w => {
            const flow = w.smartFlowScore != null ? w.smartFlowScore : (w.metrics && w.metrics.smartFlowScore);
            const pump = w.pumpFunTradeCount != null
              ? w.pumpFunTradeCount
              : (w.metrics && w.metrics.pumpFunTrades != null ? w.metrics.pumpFunTrades : null);
            const trades7d = w.tradesLast7d != null
              ? w.tradesLast7d
              : (w.metrics && w.metrics.trades7d != null ? w.metrics.trades7d : null);
            const trades30d = w.tradesLast30d != null
              ? w.tradesLast30d
              : (w.metrics && w.metrics.trades30d != null ? w.metrics.trades30d : null);
            return \`
            <tr>
              <td>\${w.name}</td>
              <td class="mint">\${w.source}</td>
              <td>\${fmtWalletAddr(w.address)}</td>
              <td>\${fmtLastTrade(w.lastActiveAt)}</td>
              <td>\${w.winRate != null ? w.winRate + '%' : '—'}</td>
              <td>\${trades7d != null ? trades7d : '—'}</td>
              <td>\${trades30d != null ? trades30d : '—'}</td>
              <td>\${pump != null ? pump : '—'}</td>
              <td>\${flow != null ? flow : '—'}</td>
              <td>\${w.alreadyTracked
                ? '<span class="mint">Tracked</span>'
                : \`<button onclick="addDiscoveredWallet('\${w.address}')">Add</button>\`
              }</td>
            </tr>\`;
          }).join('');
        }
      } catch (err) {
        // Render 502 / proxy kill while GMGN hangs — still populate Discover.
        try {
          const fallback = await fetchJSON('/api/discover-wallets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: 'manual', limit, force: true }),
            timeoutMs: 15000,
          });
          const rows = filterHighFrequencyWallets(fallback.wallets || []);
          window._discoveredWallets = rows;
          window._topWallets = rows.map(w => ({
            name: w.name,
            address: w.address,
            winRate: w.winRate,
            lastActiveAt: w.lastActiveAt,
            tradesLast7d: w.tradesLast7d,
            tradesLast30d: w.tradesLast30d,
            pumpFunTradeCount: w.pumpFunTradeCount != null
              ? w.pumpFunTradeCount
              : (w.metrics && w.metrics.pumpFunTrades != null ? w.metrics.pumpFunTrades : undefined),
            tags: w.tags,
            notes: w.notes,
            alreadyTracked: w.alreadyTracked,
            realizedPnlUsd: w.realizedPnlUsd,
            source: w.source,
          }));
          status.textContent =
            'Live sources failed (' + (err.message || err) + ') — curated · ' + rows.length + ' wallets';
          if (empty) empty.classList.add('hidden');
          const tbody = document.querySelector('#discover-wallets-table tbody');
          if (tbody && rows.length) {
            tbody.innerHTML = rows.map(w => {
              const flow = w.smartFlowScore != null ? w.smartFlowScore : (w.metrics && w.metrics.smartFlowScore);
              const pump = w.pumpFunTradeCount != null
                ? w.pumpFunTradeCount
                : (w.metrics && w.metrics.pumpFunTrades != null ? w.metrics.pumpFunTrades : null);
              const trades7d = w.tradesLast7d != null
                ? w.tradesLast7d
                : (w.metrics && w.metrics.trades7d != null ? w.metrics.trades7d : null);
              const trades30d = w.tradesLast30d != null
                ? w.tradesLast30d
                : (w.metrics && w.metrics.trades30d != null ? w.metrics.trades30d : null);
              return \`
              <tr>
                <td>\${w.name}</td>
                <td class="mint">\${w.source}</td>
                <td>\${fmtWalletAddr(w.address)}</td>
                <td>\${fmtLastTrade(w.lastActiveAt)}</td>
                <td>\${w.winRate != null ? w.winRate + '%' : '—'}</td>
                <td>\${trades7d != null ? trades7d : '—'}</td>
                <td>\${trades30d != null ? trades30d : '—'}</td>
                <td>\${pump != null ? pump : '—'}</td>
                <td>\${flow != null ? flow : '—'}</td>
                <td>\${w.alreadyTracked
                  ? '<span class="mint">Tracked</span>'
                  : \`<button onclick="addDiscoveredWallet('\${w.address}')">Add</button>\`
                }</td>
              </tr>\`;
            }).join('');
            return;
          }
        } catch (_) {}
        status.textContent = err.message;
        if (empty) {
          empty.classList.remove('hidden');
          if (emptyMsg) emptyMsg.textContent = err.message || 'Discover request failed.';
        }
      }
    }

    async function addManualDiscovered() {
      const text = ((document.getElementById('discover-manual-text') || {}).value || '').trim();
      if (!text) {
        alert('Paste at least one address (Name:Address or raw)');
        return;
      }
      const status = document.getElementById('discover-status');
      status.textContent = 'Adding manual wallets…';
      try {
        const data = await fetchJSON('/api/discover-wallets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'manual', manualText: text, limit: 50, force: true }),
          timeoutMs: 20000,
        });
        const list = data.wallets || [];
        let n = 0;
        for (const w of list) {
          if (w.alreadyTracked) continue;
          try {
            await fetchJSON('/wallets/add', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: w.name,
                address: w.address,
                winRate: w.winRate,
                lastActive: w.lastActiveAt,
                tradesLast7d: w.tradesLast7d,
                tradesLast30d: w.tradesLast30d,
                pumpFunTradeCount: w.pumpFunTradeCount,
                notes: w.notes || 'Manual add',
                tags: w.tags || ['manual'],
                source: 'manual',
              }),
            });
            n++;
          } catch (_) {}
        }
        status.textContent = 'Added ' + n + ' manual wallet(s)';
        document.getElementById('discover-source').value = 'manual';
        await discoverWallets(true);
        refresh();
      } catch (err) {
        status.textContent = err.message;
      }
    }

    function findDiscovered(address) {
      return (window._discoveredWallets || []).find(w => w.address === address)
        || (window._topWallets || []).find(w => w.address === address);
    }

    async function addDiscoveredWallet(address) {
      const w = findDiscovered(address);
      if (!w) { alert('Candidate not found'); return; }
      await fetchJSON('/wallets/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: w.name,
          address: w.address,
          winRate: w.winRate,
          lastActive: w.lastActiveAt,
          tradesLast7d: w.tradesLast7d,
          tradesLast30d: w.tradesLast30d,
          pumpFunTradeCount: w.pumpFunTradeCount,
          notes: w.notes,
          tags: w.tags,
          category: (w.tags || []).some(t => /scalp/i.test(t)) ? 'scalper' : 'smart',
          source: w.source || 'manual',
        }),
      });
      document.getElementById('discover-status').textContent = 'Added ' + w.name;
      await discoverWallets(true);
      refresh();
    }

    async function importDiscoveredAll() {
      const list = (window._discoveredWallets || []).filter(w => !w.alreadyTracked);
      if (!list.length) { alert('No new wallets to import'); return; }
      let n = 0;
      for (const w of list) {
        try {
          await fetchJSON('/wallets/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: w.name,
              address: w.address,
              winRate: w.winRate,
              lastActive: w.lastActiveAt,
              tradesLast7d: w.tradesLast7d,
              tradesLast30d: w.tradesLast30d,
              pumpFunTradeCount: w.pumpFunTradeCount,
              notes: w.notes,
              tags: w.tags,
              source: w.source || 'manual',
            }),
          });
          n++;
        } catch (_) {}
      }
      document.getElementById('discover-status').textContent = 'Imported ' + n + ' wallet(s)';
      await discoverWallets(true);
      refresh();
    }

    function applyFavouritesDiscoverForm() {
      const setVal = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
      };
      const setCheck = (id, on) => {
        const el = document.getElementById(id);
        if (el) el.checked = !!on;
      };
      setVal('discover-source', 'all');
      setVal('discover-period', '30d');
      setVal('discover-limit', '100');
      setVal('discover-min-wr', '35');
      setVal('discover-min-trades', '15');
      setCheck('discover-scalpers', true);
      setCheck('discover-exclude-hf', true);
      setCheck('discover-pump', false);
    }

    async function importFavourites() {
      applyFavouritesDiscoverForm();
      const status = document.getElementById('discover-status');
      if (status) {
        status.textContent =
          'Importing favourites (All + Kolscan + Axiom + Photon + Nansen)…';
      }
      try {
        const data = await fetchJSON('/api/discover-wallets/import-favourites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true }),
          timeoutMs: 120000,
        });
        const bySrc = (data.bySource || [])
          .map(function (s) {
            return (
              s.source +
              ':' +
              (s.imported || 0) +
              'added/' +
              (s.discovered || 0) +
              'found' +
              (s.error ? '!' : '')
            );
          })
          .join(' · ');
        const msg =
          (data.message ||
            ('Added ' +
              (data.imported || 0) +
              ' · skipped ' +
              (data.skipped || 0) +
              ' · errors ' +
              (data.errors || 0))) +
          (data.monitoring
            ? ' · watching ' +
              data.monitoring.watching +
              '/' +
              data.monitoring.tracked
            : '') +
          (bySrc ? ' · ' + bySrc : '');
        if (status) status.textContent = msg;
        await discoverWallets(true);
        refresh();
      } catch (err) {
        if (status) status.textContent = 'Favourites import failed: ' + (err.message || err);
      }
    }

    async function loadTopWallets() {
      const period = document.getElementById('top-period').value;
      const status = document.getElementById('top-status');
      const keyEl = document.getElementById('gmgn-key-status');
      status.textContent = 'Loading (GMGN → curated fallback if needed)…';
      try {
        const data = await fetchJSON(
          '/gmgn/top-wallets?period=' + period + '&minWinRate=45&limit=20',
          { timeoutMs: 25000 }
        );
        if (keyEl && data.gmgn) {
          keyEl.textContent = data.gmgn.hasApiKey ? 'API key ✓' : 'No API key (public/curated)';
          updateDiscoveryUi(data.gmgn);
        }
        const n = (data.wallets || []).length;
        status.textContent =
          (data.source || '—') +
          (data.cached ? ' (cache)' : '') +
          ' · ' + (data.period || period) +
          ' · ' + n + ' wallets' +
          (data.error ? ' · ' + data.error : '');
        window._topWallets = data.wallets || [];
        const tbody = document.querySelector('#top-wallets-table tbody');
        tbody.innerHTML = n === 0
          ? '<tr><td colspan="7" style="color:var(--muted)">No candidates</td></tr>'
          : (data.wallets || []).map(w => \`
            <tr>
              <td>\${w.name}\${w.source === 'curated' ? ' <span class="mint">curated</span>' : ''}</td>
              <td>\${fmtWalletAddr(w.address)}</td>
              <td>\${w.winRate}%</td>
              <td>\${fmtPnl(w.realizedPnlUsd ?? w.realizedPnl7d ?? w.realizedPnl30d)}</td>
              <td>\${w.tradesLast7d != null ? w.tradesLast7d : '—'}</td>
              <td>\${w.tradesLast30d != null ? w.tradesLast30d : '—'}</td>
              <td>\${w.alreadyTracked
                ? '<span class="mint">Tracked</span>'
                : \`<button onclick="addTopWallet('\${w.name.replace(/'/g, "\\\\'")}','\${w.address}')">Add to tracked</button>\`
              }</td>
            </tr>\`).join('');
      } catch (err) {
        status.textContent = err.message;
      }
    }

    function renderSearchResults(data) {
      const status = document.getElementById('search-status');
      if (data.gmgn) updateDiscoveryUi(data.gmgn);
      const rows = filterHighFrequencyWallets(data.candidates || []);
      const sug = filterHighFrequencyWallets(data.suggestedScalpers || []);
      window._searchCandidates = rows;
      window._suggestedScalpers = sug;
      status.textContent = data.message || (data.source + ' · ' + rows.length);
      const tbody = document.querySelector('#search-wallets-table tbody');
      tbody.innerHTML = rows.length === 0
        ? '<tr><td colspan="8" style="color:var(--muted)">No matches</td></tr>'
        : rows.map(w => \`
          <tr>
            <td>\${w.name}</td>
            <td>\${fmtWalletAddr(w.address)}</td>
            <td>\${w.activityLabel || '—'}</td>
            <td>\${w.winRate}%</td>
            <td>\${w.tradesLast7d != null ? w.tradesLast7d : '—'}</td>
            <td>\${w.tradesLast30d != null ? w.tradesLast30d : '—'}</td>
            <td>\${w.pumpFunTradeCount != null ? w.pumpFunTradeCount : '—'}</td>
            <td>\${w.alreadyTracked
              ? \`<button class="danger" onclick="removeSearchWallet('\${w.address}')">Remove</button>\`
              : \`<button onclick="addSearchWallet('\${w.address}')">Add</button>\`
            }</td>
          </tr>\`).join('');

      const box = document.getElementById('scalper-suggestions');
      const chips = document.getElementById('scalper-chips');
      if (sug.length) {
        box.classList.remove('hidden');
        chips.innerHTML = sug.map(w => \`
          <button class="secondary" title="\${w.address}" onclick="addSearchWallet('\${w.address}', true)">
            \${w.name} · \${w.winRate}% · \${w.tradesLast7d != null ? w.tradesLast7d + ' tx/7d' : '—'}
            \${w.alreadyTracked ? '✓' : '+'}
          </button>\`).join('');
      } else {
        box.classList.add('hidden');
      }
    }

    async function searchWallets() {
      const status = document.getElementById('search-status');
      status.textContent = 'Searching…';
      const q = document.getElementById('wallet-search-q').value.trim();
      const minWin = Number(document.getElementById('search-min-win').value) || 45;
      const minTrades = Number(document.getElementById('search-min-trades').value) || 20;
      const maxDays = Number(document.getElementById('search-max-days').value) || 7;
      const maxSniper = Number(document.getElementById('search-max-sniper').value);
      const pump = document.getElementById('search-pump-focus').checked;
      const scalperOnly = document.getElementById('search-scalper-only').checked;
      try {
        const params = new URLSearchParams({
          query: q,
          minWinRate: String(minWin),
          minTrades7d: String(minTrades),
          maxDaysInactive: String(maxDays),
          activityDays: String(maxDays),
          pumpFunFocus: pump ? 'true' : 'false',
          scalperOnly: scalperOnly ? 'true' : 'false',
          period: '7d',
          limit: '20',
        });
        if (Number.isFinite(maxSniper)) params.set('maxSniperScore', String(maxSniper));
        const data = await fetchJSON('/search-wallets?' + params.toString());
        renderSearchResults(data);
      } catch (err) {
        status.textContent = err.message;
      }
    }

    async function suggestScalpers() {
      document.getElementById('wallet-search-q').value = 'consistent scalpers';
      document.getElementById('search-min-win').value = '45';
      document.getElementById('search-min-trades').value = '20';
      document.getElementById('search-max-days').value = '7';
      document.getElementById('search-pump-focus').checked = false;
      document.getElementById('search-scalper-only').checked = true;
      const status = document.getElementById('search-status');
      status.textContent = 'Loading scalper suggestions…';
      try {
        const data = await fetchJSON('/search-wallets/suggest?limit=10');
        renderSearchResults(data);
      } catch (err) {
        status.textContent = err.message;
      }
    }

    function findSearchCandidate(address) {
      const lists = [
        window._searchCandidates || [],
        window._suggestedScalpers || [],
        window._topWallets || [],
      ];
      for (const list of lists) {
        const hit = list.find(w => w.address === address);
        if (hit) return hit;
      }
      return null;
    }

    async function addSearchWallet(address, fromChip) {
      const w = findSearchCandidate(address);
      if (!w && !fromChip) {
        alert('Candidate not found');
        return;
      }
      const payload = w ? {
        name: w.name,
        address: w.address,
        winRate: w.winRate,
        lastActive: w.lastTradeTime || w.lastActiveAt,
        lastTradeTime: w.lastTradeTime || w.lastActiveAt,
        tradesLast7d: w.tradesLast7d,
        pumpFunTradeCount: w.pumpFunTradeCount,
        notes: w.notes || (w.tags || []).join(', '),
        tags: w.tags,
        category: (w.tags || []).some(t => /scalp/i.test(t)) || (w.tradesLast7d || 0) >= 20
          ? 'scalper'
          : 'smart',
        source: 'gmgn',
      } : { name: address.slice(0, 8), address };
      try {
        await fetchJSON('/wallets/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        document.getElementById('search-status').textContent = 'Added ' + (w ? w.name : address.slice(0, 8));
        if (w) w.alreadyTracked = true;
        await searchWallets();
        refresh();
      } catch (err) {
        alert(err.message);
      }
    }

    async function removeSearchWallet(address) {
      if (!confirm('Remove this wallet from tracked list?')) return;
      try {
        await fetchJSON('/wallets/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address }),
        });
        document.getElementById('search-status').textContent = 'Removed';
        await searchWallets();
        refresh();
      } catch (err) {
        alert(err.message);
      }
    }

    async function addTopWallet(name, address) {
      try {
        await fetchJSON('/gmgn/top-wallets/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, address }),
        });
        document.getElementById('top-status').textContent = 'Added ' + name;
        await loadTopWallets();
        refresh();
      } catch (err) {
        alert(err.message);
      }
    }

    async function importAllTop() {
      const period = document.getElementById('top-period').value;
      if (!confirm('Import all new top wallets for ' + period + '?')) return;
      const status = document.getElementById('top-status');
      status.textContent = 'Importing…';
      try {
        const data = await fetchJSON('/api/gmgn/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minWinRate: 45, period }),
        });
        status.textContent = 'Added ' + data.added.length + ' (' + data.source + ')';
        await loadTopWallets();
        refresh();
      } catch (err) {
        status.textContent = err.message;
      }
    }

    /* ---------- Nansen.ai Smart Money ---------- */
    window._nansenWallets = [];
    const NANSEN_PRESET_META = {
      best_overall: { labels: ['Smart Trader', '30D Smart Trader', '90D Smart Trader'], minUsd: 500, desc: 'Smart Trader + 30D/90D, min $500 — best balance for profitable labeled wallets' },
      high_win_recent: { labels: ['30D Smart Trader', '90D Smart Trader'], minUsd: 1000, desc: '30D + 90D Smart Traders, min $1k — shorter-window top performers' },
      proven_long_term: { labels: ['Smart Trader', '90D Smart Trader', '180D Smart Trader'], minUsd: 500, desc: 'All-time + 90D/180D — historically profitable across cycles' },
      funds: { labels: ['Fund'], minUsd: 5000, desc: 'Institutional Fund wallets, min $5k trades' },
      active_traders: { labels: ['Smart Trader', '30D Smart Trader'], minUsd: 100, desc: 'Most active 24h Smart Traders (lower min size)' },
      custom: { labels: null, minUsd: null, desc: 'Use the label checkboxes below' },
    };

    function updateNansenStatusUi(nansen) {
      const keyEl = document.getElementById('nansen-key-status');
      if (!keyEl || !nansen) return;
      let credits = '';
      if (nansen.lastCreditsRemaining != null) credits = ' · credits left: ' + nansen.lastCreditsRemaining;
      else if (nansen.lastCreditsUsed != null) credits = ' · last used: ' + nansen.lastCreditsUsed;
      keyEl.textContent = nansen.hasApiKey
        ? ('API key ✓' + (nansen.cachedCount ? ' · cached ' + nansen.cachedCount : '') + credits)
        : 'No NANSEN_API_KEY';
      if (nansen.lastError) keyEl.textContent += ' · err: ' + nansen.lastError;
    }

    function onNansenPresetChange() {
      const id = document.getElementById('nansen-preset').value;
      const meta = NANSEN_PRESET_META[id] || NANSEN_PRESET_META.custom;
      const desc = document.getElementById('nansen-preset-desc');
      if (desc) desc.textContent = meta.desc;
      if (meta.minUsd != null) {
        const minEl = document.getElementById('nansen-min-usd');
        if (minEl) minEl.value = String(meta.minUsd);
      }
      if (meta.labels) {
        document.querySelectorAll('.nansen-label').forEach(function (cb) {
          cb.checked = meta.labels.indexOf(cb.value) >= 0;
        });
      }
    }

    function getNansenSelectedLabels() {
      return Array.from(document.querySelectorAll('.nansen-label:checked')).map(function (cb) {
        return cb.value;
      });
    }

    function getNansenCheckedAddresses() {
      return Array.from(document.querySelectorAll('.nansen-row-check:checked')).map(function (cb) {
        return cb.value;
      });
    }

    function toggleNansenSelectAll(on) {
      document.querySelectorAll('.nansen-row-check').forEach(function (cb) {
        cb.checked = !!on;
      });
    }

    function fmtUsdCompact(n) {
      if (n == null || !Number.isFinite(n)) return '—';
      if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
      if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'k';
      return '$' + Math.round(n);
    }

    function renderNansenTable(wallets) {
      window._nansenWallets = wallets || [];
      const tbody = document.querySelector('#nansen-wallets-table tbody');
      if (!tbody) return;
      if (!wallets || !wallets.length) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-slate-500">No wallets — Discover or import CSV/JSON</td></tr>';
        return;
      }
      tbody.innerHTML = wallets.map(function (w) {
        const addr = w.address || '';
        const short = addr.length > 12 ? addr.slice(0, 4) + '…' + addr.slice(-4) : addr;
        const label = (w.label || (w.labels && w.labels[0]) || 'Smart Money').replace(/</g, '&lt;');
        const activity =
          (w.tradeCount24h || 0) + ' tx · ' + fmtUsdCompact(w.volumeUsd24h) +
          (w.lastTradeAt ? ' · ' + fmtAgo(w.lastTradeAt) : '');
        const wr = w.winRate != null ? (Number(w.winRate).toFixed(1) + '%') : '—';
        const pnl = w.realizedPnlUsd != null ? fmtUsdCompact(w.realizedPnlUsd) : '—';
        const tokens = (w.recentTokens || []).slice(0, 3).join(', ') || '—';
        const tracked = w.alreadyTracked
          ? '<span class="mint text-xs">tracked</span>'
          : '<button class="btn btn-secondary" onclick="importNansenOne(\\'' + addr + '\\')">Add</button>';
        return '<tr>' +
          '<td><input type="checkbox" class="nansen-row-check" value="' + addr + '"' +
            (w.alreadyTracked ? '' : ' checked') + ' /></td>' +
          '<td class="font-mono text-xs" title="' + addr + '">' + short + '</td>' +
          '<td>' + label + '</td>' +
          '<td class="text-xs">' + activity + '</td>' +
          '<td>' + wr + '</td>' +
          '<td>' + pnl + '</td>' +
          '<td class="text-xs">' + tokens.replace(/</g, '&lt;') + '</td>' +
          '<td>' + tracked + '</td>' +
          '</tr>';
      }).join('');
      const selAll = document.getElementById('nansen-select-all');
      if (selAll) selAll.checked = false;
    }

    async function discoverNansen(force) {
      const status = document.getElementById('nansen-status');
      const presetId = document.getElementById('nansen-preset').value;
      const labels = getNansenSelectedLabels();
      if (!labels.length) {
        alert('Select at least one Smart Money label');
        return;
      }
      if (force && !confirm('Force refresh calls Nansen API (~5 credits). Continue?')) return;
      status.textContent = force ? 'Fetching from Nansen (~5 credits)…' : 'Loading (cache if fresh)…';
      try {
        const data = await fetchJSON('/api/nansen/discover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            presetId: presetId === 'custom' ? undefined : presetId,
            labels: labels,
            minTradeUsd: Number(document.getElementById('nansen-min-usd').value) || 0,
            limit: Number(document.getElementById('nansen-limit').value) || 50,
            force: !!force,
          }),
          timeoutMs: 45000,
        });
        renderNansenTable(data.wallets || []);
        if (data.nansen) updateNansenStatusUi(data.nansen);
        const parts = [];
        if (data.message) parts.push(data.message);
        if (data.cached) parts.push('cached');
        if (data.creditsUsed != null) parts.push('credits used: ' + data.creditsUsed);
        if (data.creditsRemaining != null) parts.push('remaining: ' + data.creditsRemaining);
        if (data.error && !data.ok) parts.push('⚠ ' + data.error);
        status.textContent = parts.join(' · ') || (data.ok ? 'OK' : 'Failed');
      } catch (err) {
        status.textContent = 'Failed: ' + (err.message || String(err));
      }
    }

    async function loadNansenCached() {
      const status = document.getElementById('nansen-status');
      status.textContent = 'Loading cache…';
      try {
        const data = await fetchJSON('/api/nansen/status');
        if (data.nansen) updateNansenStatusUi(data.nansen);
        renderNansenTable(data.wallets || []);
        status.textContent = (data.wallets && data.wallets.length)
          ? ('Cached ' + data.wallets.length + ' wallets')
          : 'No cache yet — Discover or import a file';
      } catch (err) {
        status.textContent = err.message || String(err);
      }
    }

    async function enrichNansenSelected() {
      const addrs = getNansenCheckedAddresses();
      if (!addrs.length) {
        alert('Check at least one wallet to enrich');
        return;
      }
      if (addrs.length > 10) {
        alert('Max 10 wallets per enrich (protects your free credits)');
        return;
      }
      if (!confirm('Enrich ' + addrs.length + ' wallet(s) with PnL/win rate? (~' + addrs.length + ' credits)')) return;
      const status = document.getElementById('nansen-status');
      status.textContent = 'Enriching ' + addrs.length + ' (~' + addrs.length + ' credits)…';
      try {
        const data = await fetchJSON('/api/nansen/enrich', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addresses: addrs, days: 30 }),
          timeoutMs: 90000,
        });
        renderNansenTable(data.wallets || []);
        if (data.nansen) updateNansenStatusUi(data.nansen);
        status.textContent = data.message || ('Enriched ' + (data.enriched || 0));
      } catch (err) {
        status.textContent = 'Enrich failed: ' + (err.message || String(err));
      }
    }

    async function importNansenOne(address) {
      await importNansenAddresses([address]);
    }

    async function importNansenSelected() {
      const addrs = getNansenCheckedAddresses();
      if (!addrs.length) {
        alert('Check wallets to import');
        return;
      }
      await importNansenAddresses(addrs);
    }

    async function importNansenAllNew() {
      const addrs = (window._nansenWallets || [])
        .filter(function (w) { return w && w.address && !w.alreadyTracked; })
        .map(function (w) { return w.address; });
      if (!addrs.length) {
        alert('No new wallets to import');
        return;
      }
      if (!confirm('Import ' + addrs.length + ' new Nansen wallet(s) to tracked list?')) return;
      await importNansenAddresses(addrs);
    }

    async function importNansenAddresses(addresses) {
      const status = document.getElementById('nansen-status');
      status.textContent = 'Importing ' + addresses.length + '…';
      try {
        const data = await fetchJSON('/api/nansen/import-tracked', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ addresses: addresses, onlyNew: true }),
        });
        status.textContent =
          'Added ' + (data.added || []).length +
          ' · updated ' + (data.updated || []).length +
          ' · skipped ' + (data.skipped || []).length;
        await loadNansenCached();
        refresh();
      } catch (err) {
        status.textContent = err.message || String(err);
      }
    }

    function exportNansen(format) {
      window.open('/api/nansen/export?format=' + encodeURIComponent(format || 'json'), '_blank');
      const status = document.getElementById('nansen-status');
      if (status) status.textContent = 'Exporting ' + (format || 'json') + '…';
    }

    async function importNansenFile() {
      const input = document.getElementById('nansen-import-file');
      const status = document.getElementById('nansen-status');
      if (!input || !input.files || !input.files[0]) {
        alert('Choose a CSV or JSON file first');
        return;
      }
      const file = input.files[0];
      const text = await file.text();
      const isCsv = /\\.csv$/i.test(file.name) || (!text.trim().startsWith('{') && !text.trim().startsWith('['));
      status.textContent = 'Importing file (0 credits)…';
      try {
        const data = await fetchJSON('/api/nansen/import-file', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: isCsv ? 'csv' : 'json',
            content: text,
          }),
        });
        renderNansenTable(data.wallets || []);
        if (data.nansen) updateNansenStatusUi(data.nansen);
        status.textContent = data.message || ('Loaded ' + ((data.wallets || []).length) + ' wallets');
      } catch (err) {
        status.textContent = 'Import failed: ' + (err.message || String(err));
      }
    }

    async function refreshActivity() {
      const status = document.getElementById('gmgn-status');
      status.textContent = 'Refreshing wallet activity (GMGN + on-chain)…';
      try {
        const data = await fetchJSON('/api/wallets/refresh-activity', { method: 'POST' });
        status.textContent = 'Active: ' + data.filter.kept + ' · Disabled: ' + data.filter.disabled;
        refresh();
      } catch (err) {
        status.textContent = err.message;
      }
    }

    async function pruneInactive() {
      if (!confirm('Remove wallets with no activity for more than 14 days? This cannot be undone.')) return;
      const status = document.getElementById('gmgn-status');
      if (status) status.textContent = 'Pruning inactive (>14d)…';
      try {
        const data = await fetchJSON('/api/wallets/prune-inactive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxDays: 14 }),
        });
        if (status) {
          status.textContent =
            'Pruned ' + (data.removed ?? 0) + ' (>14d) · Kept ' + (data.kept ?? 0) +
            (data.monitoring ? ' · watching ' + data.monitoring.watching : '');
        }
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
      }
    }

    async function resetWalletTracker() {
      if (
        !confirm(
          'Reset Wallet Tracker?\\n\\nThis removes ALL tracked smart wallets from the Watch list.\\n\\nBoot will not auto-import favourites again until you click Import Favourites.\\n\\nContinue?'
        )
      ) {
        return;
      }
      const status = document.getElementById('gmgn-status');
      if (status) status.textContent = 'Resetting wallet tracker…';
      try {
        const data = await fetchJSON('/api/wallets/reset-tracker', {
          method: 'POST',
        });
        if (status) {
          status.textContent =
            'Removed ' +
            (data.removed ?? 0) +
            ' wallet(s) · Import Favourites to reload';
        }
        if (typeof refresh === 'function') refresh();
        alert(data.message || 'Wallet tracker reset.');
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
        alert('Reset failed: ' + (err.message || err));
      }
    }
    window.resetWalletTracker = resetWalletTracker;

    const TP_CHECKLIST_KEY = 'tpTuningChecklistV1';
    const TP_CHECK_BEFORE = [
      { id: 'risk_on', label: 'Risk On (lean)' },
      { id: 'smart_bot', label: 'Smart Bot Profiles ON' },
      { id: 'modules_on', label: 'Allowlist modules ON for each active profile (hover Modules)' },
      { id: 'size_caps', label: 'Max Allowed Trade / Max Trade Override set' },
      { id: 'no_learn_yet', label: 'Don’t Apply learning yet' },
    ];
    const TP_CHECK_AFTER = [
      { id: 'scoreboard', label: 'Read scoreboard (Win % / PnL / hold / exit mix)' },
      { id: 'tune_exits', label: 'Tune exits on losers first (TP/SL/trail/hold)' },
      { id: 'learn_one', label: 'Apply learning one profile at a time' },
      { id: 'pause_losers', label: 'Pause chronic losers' },
      { id: 'entry_tighten', label: 'Then tighten HWR / Steady entries only' },
      { id: 'rerun', label: 'Reset → re-run short window → compare' },
      { id: 'export', label: 'Export JSON when happy' },
    ];

    function loadTuningChecklistState() {
      try {
        return JSON.parse(localStorage.getItem(TP_CHECKLIST_KEY) || '{}') || {};
      } catch (_) {
        return {};
      }
    }

    function saveTuningChecklistState(state) {
      try {
        localStorage.setItem(TP_CHECKLIST_KEY, JSON.stringify(state || {}));
      } catch (_) {}
    }

    function renderTuningChecklist() {
      const state = loadTuningChecklistState();
      function paint(elId, items) {
        const el = document.getElementById(elId);
        if (!el) return;
        el.innerHTML = items
          .map(function (item) {
            const on = state[item.id] === true;
            return (
              '<label class="' +
              (on ? 'is-done' : '') +
              '"><input type="checkbox" data-check-id="' +
              item.id +
              '"' +
              (on ? ' checked' : '') +
              ' onchange="toggleTuningChecklistItem(this)" /><span>' +
              escHtml(item.label) +
              '</span></label>'
            );
          })
          .join('');
      }
      paint('tp-check-before', TP_CHECK_BEFORE);
      paint('tp-check-after', TP_CHECK_AFTER);
    }

    function toggleTuningChecklistItem(input) {
      if (!input) return;
      const id = input.getAttribute('data-check-id');
      if (!id) return;
      const state = loadTuningChecklistState();
      state[id] = !!input.checked;
      saveTuningChecklistState(state);
      const lab = input.closest('label');
      if (lab) lab.classList.toggle('is-done', !!input.checked);
    }

    function resetTuningChecklist() {
      saveTuningChecklistState({});
      renderTuningChecklist();
    }
    window.toggleTuningChecklistItem = toggleTuningChecklistItem;
    window.resetTuningChecklist = resetTuningChecklist;

    const TP_CHECKLIST_OPEN_KEY = 'tpTuningChecklistOpenV1';
    function wireTuningChecklistCollapse() {
      const el = document.getElementById('tp-tuning-checklist-card');
      if (!el || el.tagName !== 'DETAILS') return;
      try {
        if (localStorage.getItem(TP_CHECKLIST_OPEN_KEY) === '1') {
          el.setAttribute('open', '');
        }
      } catch (_) {}
      el.addEventListener('toggle', function () {
        try {
          localStorage.setItem(
            TP_CHECKLIST_OPEN_KEY,
            el.open ? '1' : '0'
          );
        } catch (_) {}
      });
    }

    async function pruneLowQuality() {
      const hard = confirm(
        'Prune low-quality wallets?\\n\\nOK = hard-remove below threshold\\nCancel = unwatch/down-weight only (safer)'
      );
      // confirm returns false on Cancel → unwatch only; true → remove
      // Use a second confirm for clarity when removing
      let remove = false;
      if (hard) {
        remove = confirm('Hard-delete low-quality wallets? This cannot be undone.');
        if (!remove && !confirm('Unwatch / down-weight low-quality wallets instead?')) return;
      } else {
        if (!confirm('Unwatch / down-weight wallets below the quality threshold?')) return;
      }
      const status = document.getElementById('gmgn-status');
      if (status) status.textContent = remove ? 'Removing low quality…' : 'Unwatching low quality…';
      try {
        const data = await fetchJSON('/api/wallets/prune-low-quality', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remove }),
        });
        if (status) {
          status.textContent =
            (remove ? 'Removed ' + (data.removed ?? 0) : 'Unwatched ' + (data.unwatched ?? 0)) +
            ' · down-weighted ' + (data.downWeighted ?? 0) +
            (data.monitoring ? ' · watching ' + data.monitoring.watching : '');
        }
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
      }
    }

    const STRICT_INTENSITY_META = {
      low: { label: 'Strict-Low', description: 'Most selective — elite + hard quality + early entry + momentum + profit protection; tighter scalp filters (NOT “low risk mode”)' },
      medium: { label: 'Strict-Medium', description: 'Balanced strict — momentum + bonding + profit protection on top of Risk' },
      high: { label: 'Strict-High', description: 'More active Strict — momentum required; looser than Low/Medium (NOT safer than Strict-Low)' },
    };

    const ACTIVE_PROFILE_HINT =
      'Risk On = lean floors + Copy/Scanner. Risk Off = ops-only (signal soak). Enable modules manually.';

    const STATUS_ICONS = {
      play: '<polygon points="5 3 19 12 5 21 5 3"/>',
      pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',
      stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
      paper: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
      liveSim: '<polygon points="5 3 19 12 5 21 5 3"/><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" opacity=".5"/>',
      live: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
      activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
      activityBad: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/><circle cx="12" cy="12" r="9" opacity=".25"/>',
      riskLow: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
      riskMed: '<path d="M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z"/>',
      riskHigh: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
      riskDegen: '<path d="M12 3c2 3 3 5.5 3 8a3 3 0 1 1-6 0c0-2.5 1-5 3-8z"/><path d="M9.5 15.5c.5 2 1.8 3.5 2.5 4.5.7-1 2-2.5 2.5-4.5"/>',
      strictOff: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
      strictLow: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
      strictMed: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
      strictHigh: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    };

    function setStatusIcon(svgEl, key) {
      if (!svgEl) return;
      const html = STATUS_ICONS[key];
      if (html) svgEl.innerHTML = html;
    }

    function syncOverviewRunModeStatus(runState, runLabel, runIconKey, status) {
      document.querySelectorAll('[data-run-status]').forEach((el) => {
        el.className = 'run-status run-' + runState + ' has-tip';
        el.title =
          runState === 'running'
            ? 'Monitor is running and polling wallets'
            : runState === 'paused'
              ? 'Monitor is paused — no new copy entries'
              : 'Monitor is stopped';
        const d = el.querySelector('[data-run-dot]');
        if (d) {
          d.className =
            'dot ' +
            (runState === 'paused'
              ? 'dot-paused'
              : runState === 'stopped'
                ? 'dot-stopped'
                : 'dot-running');
        }
        const lab = el.querySelector('[data-run-label]');
        if (lab) lab.textContent = runLabel;
        setStatusIcon(el.querySelector('[data-run-icon]'), runIconKey);
      });
      const mode = (status && status.mode) || 'liveSimulation';
      const modeLabel =
        (status && status.modeLabel) ||
        (mode === 'liveSimulation' ? 'LIVE SIM' : String(mode).toUpperCase());
      const modeIconKey =
        mode === 'live' ? 'live' : mode === 'liveSimulation' ? 'liveSim' : 'paper';
      const modeClass =
        mode === 'live'
          ? 'badge-live'
          : mode === 'liveSimulation'
            ? 'badge-livesim'
            : 'badge-paper';
      document.querySelectorAll('[data-mode-status]').forEach((el) => {
        el.className = 'badge status-badge ' + modeClass + ' has-tip';
        el.title =
          mode === 'live'
            ? 'LIVE = real swaps with trading wallet keys'
            : mode === 'liveSimulation'
              ? 'LIVE SIM = virtual fills + live market data / live filters (no real funds)'
              : 'PAPER = simulated fills';
        const lab = el.querySelector('[data-mode-label]');
        if (lab) lab.textContent = modeLabel;
        setStatusIcon(el.querySelector('[data-mode-icon]'), modeIconKey);
      });
    }

    function formatRiskLevelLabel(level) {
      const raw = String(level || 'on').toLowerCase();
      if (raw === 'off') return 'Off';
      if (raw === 'on') return 'On';
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    function getRiskBadgeState(cfg) {
      const level = String((cfg && cfg.riskLevel) || 'on').toLowerCase();
      const label = formatRiskLevelLabel(level);
      const titles = {
        on: 'Risk On — lean floors + Copy/Scanner; enable quality modules manually',
        off: 'Risk OFF — Copy + Scanner only; no risk modules or hard floors',
      };
      const tone = level === 'off' ? 'risk-badge-high' : 'risk-badge-medium';
      const icon = level === 'off' ? 'riskHigh' : 'riskMed';
      return {
        label,
        tone,
        icon,
        title: titles[level] || titles.on,
      };
    }

    function updateRiskBadges(cfg) {
      const state = getRiskBadgeState(cfg);
      document.querySelectorAll('[data-risk-badge]').forEach((el) => {
        el.classList.remove(
          'risk-badge-low',
          'risk-badge-medium',
          'risk-badge-high',
          'risk-badge-degen'
        );
        el.classList.add(state.tone);
        el.title = state.title;
        const label = el.querySelector('.risk-badge-label');
        if (label) label.textContent = state.label;
        setStatusIcon(el.querySelector('.risk-badge-icon'), state.icon);
      });
    }

    function getStrictBadgeState(_cfg) {
      return {
        label: 'Modules',
        tone: 'strict-badge-off',
        icon: 'strictOff',
        title: 'Strict Mode removed — use Risk On/Off and module toggles.',
      };
    }

    function updateStrictBadges(_cfg) {
      /* Strict Mode badges removed from UI */
    }

    function activeProfileToneClass(cfg) {
      const level = String((cfg && cfg.riskLevel) || 'on').toLowerCase();
      if (level === 'off') return 'tone-off';
      return 'tone-medium';
    }

    function updateActiveProfileSummary(cfg) {
      const source = cfg || _lastConfig || window._lastConfig;
      if (!source) return;
      const tone = activeProfileToneClass(source);
      document.querySelectorAll('[data-active-profile]').forEach((el) => {
        el.classList.remove('tone-low', 'tone-medium', 'tone-high', 'tone-degen', 'tone-off');
        el.classList.add(tone);
        const hint = el.querySelector('.active-profile-hint');
        if (hint && !hint.querySelector('button')) {
          hint.textContent = ACTIVE_PROFILE_HINT;
        }
      });
      updateRiskBadges(source);
      updateStrictBadges(source);
    }

    function updateStrictModeUI(_cfg, _status) {
      /* Strict Mode removed */
    }

    function applyPresetConfigSnapshot(cfg, strictStatus) {
      if (!cfg) return;
      _lastConfig = cfg;
      window._cfgLoaded = false;
      applyStrategyConfigValues(cfg);
      updateRiskLevelUI(cfg);
      updateStrictModeUI(cfg, strictStatus);
    }

    async function toggleStrictMode(_enabled) {
      /* Strict Mode removed */
    }

    async function setStrictModeIntensity(_intensity) {
      /* Strict Mode removed */
    }

    async function bulkImportWallets() {
      const text = document.getElementById('bulk-import-text').value;
      const cat = document.getElementById('bulk-import-cat').value;
      const status = document.getElementById('bulk-import-status');
      status.textContent = 'Importing & activating for monitoring…';
      try {
        const data = await fetchJSON('/wallets/bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, category: cat || undefined }),
        });
        const mon = data.monitoring || {};
        status.textContent =
          (data.message ||
            ('Added ' + (data.added||[]).length +
              ', updated ' + (data.updated||[]).length +
              ', activated ' + (data.activated ?? 0))) +
          (mon.watching != null ? ' · watching ' + mon.watching + '/' + mon.tracked : '');
        document.getElementById('bulk-import-text').value = '';
        refresh();
      } catch (err) {
        status.textContent = err.message;
      }
    }

    async function saveStrategyConfig(silent) {
      await fetchJSON('/api/config/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enableMigrationOnly: document.getElementById('enableMigrationOnly').checked,
          nearMigrationCurvePct: Number(document.getElementById('nearMigrationCurvePct').value),
          earlyCurveMaxPct: Number(document.getElementById('earlyCurveMaxPct').value),
          minEarlyBirdeyeSmartMoneyScore: Number(document.getElementById('minEarlyBirdeyeSmartMoneyScore').value),
          earlyCurveMinSmartWallets: Number(document.getElementById('earlyCurveMinSmartWallets').value),
          enableAutoSell: document.getElementById('enableAutoSell').checked,
          migrationSizeMultiplier: Number(document.getElementById('migrationSizeMultiplier').value),
          migrationSlippageBps: Number(document.getElementById('migrationSlippageBps').value),
          reBuyMinProfitPct: Number(document.getElementById('reBuyMinProfitPct').value),
          reBuyDipPercent: Number(document.getElementById('reBuyDipPercent').value),
          confirmationThreshold: Number(document.getElementById('confirmationThreshold').value),
          reBuyVolumeIncreasePct: Number(document.getElementById('reBuyVolumeIncreasePct').value),
          reEntryAfterMaxProfitEnabled: document.getElementById('reEntryAfterMaxProfitEnabled').checked,
          reEntryMaxPerMint: Number(document.getElementById('reEntryMaxPerMint').value),
          reEntryWatchMinutes: Number(document.getElementById('reEntryWatchMinutes').value),
          reEntryMinReclaimPct: Number(document.getElementById('reEntryMinReclaimPct').value),
          reEntryMinVolumeIncreasePct: Number(document.getElementById('reEntryMinVolumeIncreasePct').value),
          reEntrySizeMultiplier: Number(document.getElementById('reEntrySizeMultiplier').value),
          reEntryCooldownMinutes: Number(document.getElementById('reEntryCooldownMinutes').value),
          reBuyMaxPerMint: Number(document.getElementById('reEntryMaxPerMint').value),
        }),
      });
      if (!silent) alert('Strategy saved');
    }

    async function saveRiskConfig(silent) {
      await fetchJSON('/api/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('riskEnabled').checked,
          tieredSellEnabled: document.getElementById('tieredSellEnabled').checked,
          autoPauseOnLimit: document.getElementById('autoPauseOnLimit').checked,
          riskPercentPerTrade: Number(document.getElementById('riskPercentPerTrade').value),
          trailingStopPercent: Number(document.getElementById('trailingStopPct').value),
          trailingStopPct: Number(document.getElementById('trailingStopPct').value),
          trailingActivationProfit: Number(document.getElementById('trailingActivationProfit').value),
          maxDrawdownPct: Number(document.getElementById('maxDrawdownPct').value),
          weeklyLossLimitSol: Number(document.getElementById('weeklyLossLimitSol').value),
          minTradeSol: Number(document.getElementById('minTradeSol').value),
          maxTradeSol: Number(document.getElementById('maxTradeSol').value),
          deadVolumeUsdPerHour: Number(document.getElementById('deadVolumeUsdPerHour').value),
          deadVolumeConsecutiveHours: Number(document.getElementById('deadVolumeConsecutiveHours').value),
          deadVolumeMinHoldMinutes: Number(document.getElementById('deadVolumeMinHoldMinutes').value),
          normal: {
            riskPercentPerTrade: Number(document.getElementById('normalRiskPct').value),
            trailingStopPct: Number(document.getElementById('normalTrailPct').value),
          },
          migration: {
            riskPercentPerTrade: Number(document.getElementById('migRiskPct').value),
            trailingStopPct: Number(document.getElementById('migTrailPct').value),
          },
        }),
      });
      if (!silent) alert('Risk settings saved');
      refresh();
    }

    function updateRiskLevelUI(cfg) {
      const level = (cfg && cfg.riskLevel) || 'on';
      const sum = (cfg && cfg.riskLevelSummary) || {};
      const active = sum.active || {};
      const ids = ['on', 'off'];
      ids.forEach((id) => {
        ['risk-lvl-'].forEach((prefix) => {
          const btn = document.getElementById(prefix + id);
          if (!btn) return;
          const on = id === level;
          if (id === 'off') {
            btn.className = on
              ? 'btn text-xs sm:text-sm'
              : 'btn bg-slate-800 text-slate-300 text-xs sm:text-sm';
            btn.style.background = on ? '#475569' : '';
            btn.style.color = on ? '#fff' : '';
            btn.style.borderColor = '#64748b';
          } else {
            btn.className = on
              ? 'btn btn-primary text-xs sm:text-sm'
              : 'btn bg-slate-800 text-slate-300 text-xs sm:text-sm';
            btn.style.background = '';
            btn.style.color = '';
            btn.style.borderColor = '';
          }
        });
      });
      const label = document.getElementById('risk-level-label');
      if (label) label.textContent = (sum.label || level).toUpperCase() + (sum.description ? ' — ' + sum.description : '');

      const warnText =
        level === 'off'
          ? (sum.warning || '⚠️ Risk OFF — ops-only soak. Hard floors bypassed. Concurrent ≥ 30.')
          : '';
      ['risk-level-warning', 'cfg-risk-level-warning'].forEach((wid) => {
        const w = document.getElementById(wid);
        if (!w) return;
        if (warnText) {
          w.textContent = warnText;
          w.classList.remove('hidden');
          w.style.color = level === 'off' ? '#94a3b8' : '';
        } else {
          w.textContent = '';
          w.classList.add('hidden');
          w.style.color = '';
        }
      });

      const summaryLines = [
        'Base ' + (active.baseTradeAmountSol ?? '—') + ' SOL',
        'SL ' + (active.stopLossPercent ?? '—') + '%',
        'max risk score ' + (active.maxRiskScore ?? '—'),
        'min liq $' + (active.minLiquidity != null ? Number(active.minLiquidity).toLocaleString() : '—'),
        'conv ' + (active.convergenceRequired ?? '—'),
        'max pos ' + (active.maxConcurrentPositions ?? '—'),
        'risk%/trade ' + (active.riskPercentPerTrade ?? '—'),
        'max DD ' + (active.maxDrawdownPct ?? '—') + '%',
        'conviction ≥' + (active.minConvictionScore ?? '—'),
        'max ' + (active.maxTradesPerHour ?? '—') + '/hr',
      ];
      const summaryHtml = summaryLines.join(' · ');
      const ov = document.getElementById('risk-level-summary');
      if (ov) ov.textContent = summaryHtml;
      const cfgSum = document.getElementById('cfg-risk-level-summary');
      if (cfgSum) cfgSum.textContent = summaryHtml;

      const recipeBlurb = document.getElementById('risk-recipe-blurb');
      if (recipeBlurb) {
        const counts = sum.recipeCounts;
        const mode = sum.recipeMode === 'custom' ? 'Custom modules' : 'Synced';
        const bits = [];
        if (sum.recipeSummary) bits.push(sum.recipeSummary);
        if (counts) bits.push(counts.enabledCore + ' core · ' + counts.enabledRisk + ' risk-linked ON');
        bits.push(mode);
        recipeBlurb.textContent = bits.length ? bits.join(' · ') : '—';
      }

      const btBanner = document.getElementById('bt-config-banner');
      if (btBanner && cfg && cfg.trade) {
        const base = cfg.trade.baseTradeAmountSol ?? cfg.trade.tradeAmountSol;
        const preset = String(cfg.strategyProfile || 'custom').replace(/_/g, ' ');
        btBanner.textContent =
          'Live: ' + preset + ' preset · ' + String(level).toUpperCase() +
          ' risk · base ' + base +
          ' SOL · SL ' + cfg.trade.stopLossPercent + '% · max profit ' +
          cfg.trade.maxProfitPercent +
          '% · Backtest / Live Sim inherit these gates. Overrides below are optional.';
      }
      updateActiveProfileSummary(Object.assign({}, _lastConfig || {}, cfg || {}));
    }

    async function setRiskLevel(level) {
      if (level === 'off') {
        const ok = confirm(
          '⚠️ Risk OFF — ops-only soak (Copy + Scanner).\\nNo hard floors / quality gates.\\nMax concurrent opens 40 · small size.\\nOps rejects only (holding, denied, pause, balance).\\n\\nApply Risk OFF?'
        );
        if (!ok) return;
      }
      try {
        const data = await fetchJSON('/api/config/risk-level', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ riskLevel: level }),
        });
        if (data.config) {
          applyPresetConfigSnapshot(data.config);
          if (typeof updateStrictModeUI === 'function') updateStrictModeUI(data.config, null);
        }
        await refresh();
        if (typeof loadStrategies === 'function') await loadStrategies();
        const recipeNote =
          data.summary && data.summary.recipeMode === 'synced'
            ? '\\nStrategy modules re-synced to this Risk Level.'
            : data.summary && data.summary.recipeMode === 'custom'
              ? '\\nStrategy modules left custom (Reset Strategy Defaults for a full code reset).'
              : '';
        alert(
          'Risk level set to ' + String(level).toUpperCase() +
          (data.warning ? '\\n' + data.warning : '') +
          recipeNote +
          '\\nRecommended settings applied.'
        );
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    async function applySoakPreset() {
      const ok = confirm(
        'Apply Soak preset?\\n• Risk Off (ops-only)\\n• Max concurrent 40\\n• Small base size\\n• Clear skip-reason counters\\n\\nGoal: many signal entries (15–30+), not profit.'
      );
      if (!ok) return;
      try {
        const data = await fetchJSON('/api/tuning/soak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (data.config) applyPresetConfigSnapshot(data.config);
        await refresh();
        if (typeof loadStrategies === 'function') await loadStrategies();
        alert(data.hint || 'Soak preset applied.');
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    async function resetSkipReasonCounts() {
      try {
        await fetchJSON('/api/tuning/skip-reasons/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        await refresh();
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    async function enableNextTuneModule() {
      try {
        const data = await fetchJSON('/api/tuning/module-next', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (typeof loadStrategies === 'function') await loadStrategies();
        else renderModuleTune(data.moduleTune || (data.status && data.status));
        await refresh();
        if (data.enabled) {
          alert('Enabled module: ' + data.enabled + '\\nRe-check soak opens/hr + skip reasons before enabling another.');
        } else {
          alert((data.status && data.status.hint) || 'All recommended tune modules already ON.');
        }
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    function renderModuleTune(mt) {
      const list = document.getElementById('module-tune-list');
      const hint = document.getElementById('module-tune-hint');
      if (!mt) return;
      if (hint) hint.textContent = mt.hint || '';
      if (!list) return;
      list.innerHTML = (mt.order || []).map(function (s) {
        const mark = s.enabled ? 'ON' : 'off';
        const color = s.enabled ? 'var(--green)' : 'var(--muted)';
        return '<li><span style="color:' + color + '">[' + mark + ']</span> ' +
          escHtml(String(s.index) + '. ' + s.label) +
          ' <span class="mint">— ' + escHtml(s.why || '') + '</span></li>';
      }).join('');
    }

    async function saveProfitStrategy(silent) {
      const status = document.getElementById('ps-status');
      try {
        const data = await fetchJSON('/api/profit-strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            riskBasedAdjustment: document.getElementById('ps-risk-adjust').checked,
            partialSellAt: Number(document.getElementById('ps-partial-at').value),
            partialSellPercent: Number(document.getElementById('ps-partial-sell').value),
            takeInitialPercent: Number(document.getElementById('ps-take-initial').value),
            bagPercent: Number(document.getElementById('ps-bag').value),
            trailingStopAfter: Number(document.getElementById('ps-trail-after').value),
            trailingStopPct: Number(document.getElementById('ps-trail-pct').value),
          }),
        });
        if (status) {
          status.textContent = data.profitStrategy?.enabled
            ? 'Saved · strategy ON'
            : 'Saved · strategy OFF';
        }
        if (!silent) alert('Profit strategy settings saved');
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
      }
    }

    async function saveQuickScalperConfig(silent) {
      let sl = Number(document.getElementById('qs-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      await fetchJSON('/api/short-term/quick_scalper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeLimitMinutes: Number(document.getElementById('qs-time-limit')?.value) || 2,
          takeProfitPct: Number(document.getElementById('qs-take-profit')?.value),
          stopLossPct: sl,
          minVolumeUsd: Number(document.getElementById('qs-min-volume')?.value),
          minBuyPressureUsd: Number(document.getElementById('qs-min-buy-pressure')?.value),
        }),
      });
      if (!silent) alert('Quick Scalper settings saved');
      refresh();
    }

    async function saveMicroScalperConfig(silent) {
      let sl = Number(document.getElementById('ms-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      await fetchJSON('/api/short-term/micro_scalper', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeLimitSeconds: Number(document.getElementById('ms-time-seconds')?.value) || 75,
          takeProfitPct: Number(document.getElementById('ms-take-profit')?.value),
          stopLossPct: sl,
          minVolumeUsd: Number(document.getElementById('ms-min-volume')?.value),
          minBuyPressureUsd: Number(document.getElementById('ms-min-buy-pressure')?.value),
        }),
      });
      if (!silent) alert('Micro-Scalper settings saved');
      refresh();
    }

    async function saveMomentumBurstConfig(silent) {
      let sl = Number(document.getElementById('mb-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      await fetchJSON('/api/short-term/momentum_burst', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeLimitSeconds: Number(document.getElementById('mb-time-seconds')?.value) || 180,
          takeProfitPct: Number(document.getElementById('mb-take-profit')?.value),
          stopLossPct: sl,
          momentumFailDropPct: Number(document.getElementById('mb-fail-drop')?.value),
          minVolumeUsd: Number(document.getElementById('mb-min-volume')?.value),
          minBuyPressureUsd: Number(document.getElementById('mb-min-buy-pressure')?.value),
        }),
      });
      if (!silent) alert('Momentum Burst settings saved');
      refresh();
    }

    async function savePostMigrationScalpConfig(silent) {
      let sl = Number(document.getElementById('pms-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      await fetchJSON('/api/short-term/post_migration_scalp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeLimitSeconds: Number(document.getElementById('pms-time-seconds')?.value) || 120,
          takeProfitPct: Number(document.getElementById('pms-take-profit')?.value),
          stopLossPct: sl,
          minVolumeUsd: Number(document.getElementById('pms-min-volume')?.value),
          minBuyPressureUsd: Number(document.getElementById('pms-min-buy-pressure')?.value),
        }),
      });
      if (!silent) alert('Post-Migration Scalp settings saved');
      refresh();
    }

    async function saveReversalScalpConfig(silent) {
      let sl = Number(document.getElementById('rs-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      await fetchJSON('/api/short-term/reversal_scalp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeLimitSeconds: Number(document.getElementById('rs-time-seconds')?.value) || 90,
          takeProfitPct: Number(document.getElementById('rs-take-profit')?.value),
          stopLossPct: sl,
          minDropFromPeakPct: Number(document.getElementById('rs-min-drop')?.value),
          minConvictionScore: Number(document.getElementById('rs-min-conviction')?.value),
          minVolumeUsd: Number(document.getElementById('rs-min-volume')?.value),
          minBuyPressureUsd: Number(document.getElementById('rs-min-buy-pressure')?.value),
        }),
      });
      if (!silent) alert('Reversal Scalp settings saved');
      refresh();
    }

    async function applyPostRunDipProfile(profile) {
      const p =
        profile === 'conservative'
          ? 'conservative'
          : profile === 'aggressive'
            ? 'aggressive'
            : 'standard';
      const label =
        p === 'conservative'
          ? 'Conservative Post-Run Dip'
          : p === 'aggressive'
            ? 'Aggressive Post-Run Dip'
            : 'Standard (Recommended)';
      const detail =
        p === 'conservative'
          ? 'Higher quality, fewer trades.\\n\\n' +
            '· Min run ≥+120%\\n' +
            '· Age 8–18h\\n' +
            '· Fib only 0.5 / 0.618 (±1.5–2%)\\n' +
            '· Liq ≥$12k · Holders ≥80\\n' +
            '· Clear volume dry-up then return\\n' +
            '· Smart money strongly preferred\\n' +
            '· Peak US / Europe–US session required\\n' +
            '· Faster zone-break invalidation\\n' +
            '· Higher qualify score (≥72)\\n\\n' +
            'Enables Post-Run Dip and aligns preferred sessions to US+overlaps.'
          : p === 'aggressive'
            ? 'More opportunities, looser thresholds.\\n\\n' +
              '· Min run +60–100%\\n' +
              '· Age up to 24–36h (window 6–36h)\\n' +
              '· Fib 0.382 / 0.5 / 0.618 (±3–4%)\\n' +
              '· Liq ≥$6.5k · Holders ≥40\\n' +
              '· Flexible volume confirmation\\n' +
              '· Smart money optional\\n' +
              '· Wider sessions (Asia/Europe/US)\\n' +
              '· More patient dip watch / hold\\n' +
              '· Lower qualify score (≥45)\\n\\n' +
              'Enables Post-Run Dip and widens preferred sessions.'
            : 'Balanced Post-Run Dip defaults.\\n\\n' +
              '· Run +80–150% · Age 12–24h\\n' +
              '· Fib 0.5/0.618 ±2.5% · Liq ≥$10k · Holders ≥60\\n' +
              '· Vol↓then↑ · SM preferred · Soft session prefer\\n\\n' +
              'Enables Post-Run Dip.';
      if (!confirm('Apply ' + label + '?\\n\\n' + detail)) return;
      try {
        await fetchJSON('/api/short-term/post_run_dip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ profile: p, enabled: true }),
        });
        window._cfgLoaded = false;
        await refresh();
        alert(label + ' applied');
      } catch (err) {
        alert('Apply failed: ' + (err.message || String(err)));
      }
    }

    async function savePostRunDipConfig(silent) {
      let sl = Number(document.getElementById('prd-stop-loss')?.value);
      if (Number.isFinite(sl) && sl > 0) sl = -sl;
      const sessionsRaw = document.getElementById('prd-sessions')?.value || 'us,europe_us';
      const preferredSessions = String(sessionsRaw)
        .split(',')
        .map((s) => String(s).trim())
        .filter(Boolean);
      const fibsRaw = document.getElementById('prd-fibs')?.value || '0.5,0.618';
      const preferredFibLevels = String(fibsRaw)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n));
      await fetchJSON('/api/short-term/post_run_dip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sensitivity: document.getElementById('prd-sensitivity')?.value || 'medium',
          timeLimitMinutes: Number(document.getElementById('prd-time-minutes')?.value) || 90,
          setupWatchMinutes: Number(document.getElementById('prd-setup-watch')?.value) || 60,
          takeProfitPct: Number(document.getElementById('prd-take-profit')?.value),
          stopLossPct: sl,
          minRunPct: Number(document.getElementById('prd-min-run')?.value) || 80,
          maxRunPct: Number(document.getElementById('prd-max-run')?.value) || 150,
          minDipFromPeakPct: Number(document.getElementById('prd-min-dip')?.value),
          maxDipFromPeakPct: Number(document.getElementById('prd-max-dip')?.value),
          minTokenAgeHours: Number(document.getElementById('prd-min-age')?.value) || 12,
          maxTokenAgeHours: Number(document.getElementById('prd-max-age')?.value) || 24,
          nearTechnicalPct: Number(document.getElementById('prd-near-pct')?.value) || 2.5,
          minLiquidityUsd: Number(document.getElementById('prd-min-liq')?.value) || 10000,
          minHolders: Number(document.getElementById('prd-min-holders')?.value) || 60,
          minVolumeUsd: Number(document.getElementById('prd-min-vol')?.value) || 5000,
          boostPoints: Number(document.getElementById('prd-boost')?.value) || 12,
          boostPointsMax: 20,
          minQualifyScore: Number(document.getElementById('prd-min-score')?.value) || 55,
          preferredFibLevels: preferredFibLevels.length
            ? preferredFibLevels
            : [0.5, 0.618],
          preferredSessions,
          preferNearTechnicals: document.getElementById('prd-prefer-tech')
            ? document.getElementById('prd-prefer-tech').checked
            : true,
          requireNearTechnicals: document.getElementById('prd-require-tech')
            ? document.getElementById('prd-require-tech').checked
            : false,
          preferSmartMoney: document.getElementById('prd-prefer-sm')
            ? document.getElementById('prd-prefer-sm').checked
            : false,
          stronglyPreferSmartMoney: document.getElementById('prd-strong-sm')
            ? document.getElementById('prd-strong-sm').checked
            : false,
          requireSmartMoney: document.getElementById('prd-require-sm')
            ? document.getElementById('prd-require-sm').checked
            : false,
          hardRequireSmartMoneyInConservative: document.getElementById('prd-sm-hard-cons')
            ? document.getElementById('prd-sm-hard-cons').checked
            : false,
          smartWalletDipSensitivity: document.getElementById('prd-sm-sens')?.value || 'medium',
          smartWalletDipBoostPoints: Number(document.getElementById('prd-sm-boost')?.value) || 8,
          requireClearVolumeDryUp: document.getElementById('prd-clear-vol')
            ? document.getElementById('prd-clear-vol').checked
            : false,
          flexibleVolumeConfirmation: document.getElementById('prd-flex-vol')
            ? document.getElementById('prd-flex-vol').checked
            : false,
          requirePreferredSession: document.getElementById('prd-req-session')
            ? document.getElementById('prd-req-session').checked
            : false,
          invalidateOnZoneBreak: document.getElementById('prd-zone-break')
            ? document.getElementById('prd-zone-break').checked
            : true,
          invalidateRequireVolume: document.getElementById('prd-zone-vol')
            ? document.getElementById('prd-zone-vol').checked
            : true,
          hardRequireSetup: document.getElementById('prd-hard-require')
            ? document.getElementById('prd-hard-require').checked
            : false,
        }),
      });
      if (!silent) alert('Post-Run Dip settings saved');
      refresh();
    }

    function fillMarketScannerForm(cfg, status) {
      if (!cfg) return;
      const en = document.getElementById('ms-enabled');
      if (en) {
        // Prefer live strategy gate from status when present
        en.checked =
          status && status.enabled != null
            ? Boolean(status.enabled)
            : cfg.enabled !== false;
      }
      const reqTa = document.getElementById('ms-require-ta');
      if (reqTa) reqTa.checked = cfg.requireTaSetup !== false;
      const prefReal = document.getElementById('ms-prefer-real');
      if (prefReal) prefReal.checked = cfg.preferRealCandles !== false;
      const pauseRisk = document.getElementById('ms-pause-risk');
      if (pauseRisk) pauseRisk.checked = cfg.pauseScannerOnlyInRiskOff !== false;
      const reqRs = document.getElementById('ms-require-rs');
      if (reqRs) reqRs.checked = cfg.requireRsForMomentum !== false;
      const reqMtf = document.getElementById('ms-require-mtf');
      if (reqMtf) reqMtf.checked = cfg.requireMtfAligned === true;
      const prefOrg = document.getElementById('ms-prefer-organic');
      if (prefOrg) prefOrg.checked = cfg.preferOrganicVolume !== false;
      const jupEn = document.getElementById('ms-jup-enabled');
      if (jupEn) jupEn.checked = cfg.jupiterTrendingEnabled !== false;
      const jupPump = document.getElementById('ms-jup-pump');
      if (jupPump) jupPump.checked = cfg.jupiterPumpFunOnly !== false;
      const jupMerge = document.getElementById('ms-jup-merge');
      if (jupMerge) jupMerge.checked = cfg.jupiterMergeIntervals !== false;
      const jupCat = document.getElementById('ms-jup-category');
      if (jupCat && cfg.jupiterCategory) {
        jupCat.value = String(cfg.jupiterCategory);
      }
      const setNum = (id, v) => {
        const el = document.getElementById(id);
        if (el && v != null && Number.isFinite(Number(v))) el.value = Number(v);
      };
      setNum('ms-poll-ms', cfg.pollIntervalMs);
      setNum('ms-lookback-h', cfg.lookbackHours);
      setNum('ms-max-cands', cfg.maxCandidatesPerPoll);
      setNum('ms-cooldown-ms', cfg.cooldownMs);
      setNum('ms-min-rank', cfg.minRankScore);
      setNum('ms-min-pat-conf', cfg.minPatternConfidence);
      setNum('ms-synth-pen', cfg.syntheticPenalty);
      setNum('ms-min-confl', cfg.minConfluenceScore);
      setNum('ms-min-liq', cfg.minLiquidityUsd);
      setNum('ms-min-organic', cfg.minOrganicScore);
      setNum('ms-jup-limit', cfg.jupiterLimit);
      setNum('ms-vol-m5', cfg.minVolumeM5Usd);
      setNum('ms-vol-h1', cfg.minVolumeH1Usd);
      setNum('ms-vol-h6', cfg.minVolumeH6Usd);
      setNum('ms-vol-h24', cfg.minVolumeH24Usd);
      const jupSt = document.getElementById('ms-jupiter-status');
      if (jupSt) {
        const j = status && status.jupiter ? status.jupiter : null;
        if (!j) {
          jupSt.textContent = 'Jupiter: —';
        } else {
          const key = j.hasApiKey ? 'key OK' : 'no JUPITER_API_KEY';
          const cnt = j.lastCount != null ? ' · last ' + j.lastCount : '';
          const err = j.lastError ? ' · ' + String(j.lastError).slice(0, 80) : '';
          jupSt.textContent = 'Jupiter: ' + key + cnt + err;
        }
      }
      const statusEl = document.getElementById('scanner-status-tab');
      if (statusEl && status && status.regime) {
        const r = status.regime;
        const outN =
          status.outcomes && status.outcomes.total != null
            ? status.outcomes.total
            : 0;
        statusEl.dataset.regimeLine =
          'Regime ' +
          String(r.regime || '—') +
          ' · SOL h1 ' +
          (r.solChangeH1 != null ? Number(r.solChangeH1).toFixed(1) + '%' : '—') +
          ' · h24 ' +
          (r.solChangeH24 != null ? Number(r.solChangeH24).toFixed(1) + '%' : '—') +
          (outN ? ' · outcomes ' + outN : '');
      }
    }

    async function loadMarketScannerConfig() {
      const st = document.getElementById('ms-save-status');
      try {
        const data = await fetchJSON('/api/market-scanner');
        fillMarketScannerForm(data.config || {}, data.status || {});
        if (st) st.textContent = 'Loaded';
      } catch (err) {
        if (st) st.textContent = err.message || String(err);
      }
    }

    async function saveMarketScannerConfig(silent) {
      const st = document.getElementById('ms-save-status');
      if (st) st.textContent = 'Saving…';
      try {
        const body = {
          enabled: document.getElementById('ms-enabled')
            ? document.getElementById('ms-enabled').checked
            : true,
          requireTaSetup: document.getElementById('ms-require-ta')
            ? document.getElementById('ms-require-ta').checked
            : true,
          preferRealCandles: document.getElementById('ms-prefer-real')
            ? document.getElementById('ms-prefer-real').checked
            : true,
          pauseScannerOnlyInRiskOff: document.getElementById('ms-pause-risk')
            ? document.getElementById('ms-pause-risk').checked
            : true,
          requireRsForMomentum: document.getElementById('ms-require-rs')
            ? document.getElementById('ms-require-rs').checked
            : true,
          requireMtfAligned: document.getElementById('ms-require-mtf')
            ? document.getElementById('ms-require-mtf').checked
            : false,
          preferOrganicVolume: document.getElementById('ms-prefer-organic')
            ? document.getElementById('ms-prefer-organic').checked
            : true,
          jupiterTrendingEnabled: document.getElementById('ms-jup-enabled')
            ? document.getElementById('ms-jup-enabled').checked
            : true,
          jupiterPumpFunOnly: document.getElementById('ms-jup-pump')
            ? document.getElementById('ms-jup-pump').checked
            : true,
          jupiterMergeIntervals: document.getElementById('ms-jup-merge')
            ? document.getElementById('ms-jup-merge').checked
            : true,
          jupiterCategory: document.getElementById('ms-jup-category')?.value || 'toptraded',
          pollIntervalMs: Number(document.getElementById('ms-poll-ms')?.value) || 15000,
          lookbackHours: Number(document.getElementById('ms-lookback-h')?.value) || 6,
          maxCandidatesPerPoll: Number(document.getElementById('ms-max-cands')?.value) || 15,
          cooldownMs: Number(document.getElementById('ms-cooldown-ms')?.value) || 2700000,
          minRankScore: Number(document.getElementById('ms-min-rank')?.value) || 42,
          minPatternConfidence: Number(document.getElementById('ms-min-pat-conf')?.value) || 55,
          syntheticPenalty: Number(document.getElementById('ms-synth-pen')?.value) || 8,
          minConfluenceScore: Number(document.getElementById('ms-min-confl')?.value) || 40,
          minLiquidityUsd: Number(document.getElementById('ms-min-liq')?.value) || 0,
          minOrganicScore: Number(document.getElementById('ms-min-organic')?.value) || 0,
          jupiterLimit: Number(document.getElementById('ms-jup-limit')?.value) || 100,
          minVolumeM5Usd: Number(document.getElementById('ms-vol-m5')?.value) || 0,
          minVolumeH1Usd: Number(document.getElementById('ms-vol-h1')?.value) || 0,
          minVolumeH6Usd: Number(document.getElementById('ms-vol-h6')?.value) || 0,
          minVolumeH24Usd: Number(document.getElementById('ms-vol-h24')?.value) || 0,
          playbookMode: 'auto',
        };
        const data = await fetchJSON('/api/config/market-scanner', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        fillMarketScannerForm(data.config || body, data.status || {});
        if (st) {
          st.textContent =
            'Saved' +
            (data.status && data.status.enabled != null
              ? (data.status.enabled ? ' · ON' : ' · OFF')
              : '');
        }
        if (!silent) {
          /* status line is enough */
        }
        // Refresh strategies list so the module toggle matches
        try { if (typeof loadStrategies === 'function') loadStrategies(); } catch (_) {}
        refresh();
      } catch (err) {
        if (st) st.textContent = err.message || String(err);
        if (!silent) alert(err.message || String(err));
      }
    }

    let _zionShownOffers = window._zionShownOffers || new Set();
    window._zionShownOffers = _zionShownOffers;
    let _zionActiveOfferId = null;
    let _zionCache = null;
    let _zionFormHydrated = false;
    let _zionSaveInFlight = false;
    /** After first /api/zion payload, only NEW offers auto-popup (not refresh/reload). */
    let _zionOffersBootstrapped = false;
    const ZION_DISMISSED_KEY = 'zionDismissedOfferIds';
    const ZION_POPUP_TTL_MS = 30_000;
    const _zionPopupTimers = window._zionPopupTimers || new Map();
    window._zionPopupTimers = _zionPopupTimers;

    function loadZionDismissedIds() {
      try {
        const raw = JSON.parse(localStorage.getItem(ZION_DISMISSED_KEY) || '[]');
        return new Set(Array.isArray(raw) ? raw.map(String) : []);
      } catch (_) {
        return new Set();
      }
    }
    function persistZionDismissedIds(set) {
      try {
        localStorage.setItem(
          ZION_DISMISSED_KEY,
          JSON.stringify(Array.from(set).slice(-200))
        );
      } catch (_) {}
    }
    let _zionDismissedOffers = loadZionDismissedIds();

    function markZionOfferDismissedLocal(id) {
      if (!id) return;
      _zionDismissedOffers.add(String(id));
      _zionShownOffers.add(String(id));
      persistZionDismissedIds(_zionDismissedOffers);
      try {
        fetchJSON(
          '/api/zion/offers/' + encodeURIComponent(id) + '/dismiss',
          { method: 'POST' }
        ).catch(function () {});
      } catch (_) {}
    }

    function zionOfferTitle(o) {
      if (!o) return '?';
      const mint = String(o.mint || '');
      const sym = String(o.symbol || '').trim();
      const name = String(o.name || '').trim();
      const looksPrefix =
        sym &&
        mint &&
        mint.toLowerCase().startsWith(sym.toLowerCase()) &&
        sym.length <= 12;
      if (sym && !looksPrefix) return sym;
      if (
        name &&
        !(mint && mint.toLowerCase().startsWith(name.toLowerCase()) && name.length <= 12)
      ) {
        return name;
      }
      return sym || name || (mint ? mint.slice(0, 6) : '?');
    }

    function zionEntryLiveStatHtml(label, entryVal, liveVal) {
      const entry = zionFmtUsd(entryVal);
      const live =
        liveVal != null && Number.isFinite(Number(liveVal))
          ? zionFmtUsd(liveVal)
          : entry;
      const showBoth =
        liveVal != null &&
        Number.isFinite(Number(liveVal)) &&
        entryVal != null &&
        Number.isFinite(Number(entryVal)) &&
        Math.round(Number(liveVal)) !== Math.round(Number(entryVal));
      return (
        '<div class="zion-offer-stat" data-zion-stat="' +
        escAttr(label) +
        '">' +
        '<span class="lbl">' +
        escHtml(label) +
        '</span>' +
        '<span class="val" data-zion-live-val>' +
        live +
        '</span>' +
        '<span class="sub">Entry <strong data-zion-entry-val>' +
        entry +
        '</strong>' +
        (showBoth ? '' : '') +
        '</span>' +
        '</div>'
      );
    }

    function fillZionForm(cfg) {
      if (!cfg) return;
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      const setVal = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = v; };
      setChk('zion-enabled', cfg.enabled);
      setChk('zion-scanner-enabled', cfg.scanner?.enabled !== false);
      setChk('zion-auto-offer', cfg.autoOfferFromScanner !== false);
      setChk('zion-tracked-boost', cfg.useTrackedWalletsAsBoost !== false);
      setChk('zion-email-offer', cfg.notifyEmailOnOffer !== false);
      setChk('zion-email-placed', cfg.notifyEmailOnPlaced !== false);
      setChk('zion-use-exits', cfg.defaults?.useExitPresets !== false);
      setVal('zion-min-kol', cfg.minKolWallets);
      setVal('zion-min-quality', cfg.minWalletQuality);
      setVal('zion-min-mc', cfg.minMcUsd);
      setVal('zion-max-mc', cfg.maxMcUsd);
      setVal('zion-ttl', cfg.offerTtlMinutes);
      setVal('zion-cooldown', cfg.mintCooldownMinutes);
      setVal('zion-universe', cfg.scanner?.universeSize);
      setVal('zion-poll-ms', cfg.scanner?.pollIntervalMs);
      setVal('zion-size-mode', cfg.defaults?.sizeMode || 'sol');
      setVal('zion-sol', cfg.defaults?.solAmount);
      setVal('zion-usd', cfg.defaults?.usdAmount);
      setVal('zion-tp', cfg.defaults?.takeProfitPct);
      setVal('zion-sl', cfg.defaults?.stopLossPct);
      setVal('zion-trail', cfg.defaults?.trailingStopPct);
      setVal('zion-trail-act', cfg.defaults?.trailingActivationProfit);
      _zionFormHydrated = true;
    }

    function zionOfferDisplayStatus(o) {
      const now = Date.now();
      if (!o) return { key: 'expired', label: 'Expired' };
      if (o.status === 'pending') {
        if (o.expiresAt && o.expiresAt <= now) {
          return { key: 'expired', label: 'Expired' };
        }
        return { key: 'active', label: 'Active' };
      }
      if (o.status === 'expired') return { key: 'expired', label: 'Expired' };
      if (o.status === 'executed') return { key: 'executed', label: 'Executed' };
      if (o.status === 'failed') return { key: 'failed', label: 'Failed' };
      if (o.status === 'declined') return { key: 'declined', label: 'Declined' };
      if (o.status === 'approved') return { key: 'approved', label: 'Approved' };
      return { key: String(o.status || 'expired'), label: String(o.status || 'Expired') };
    }

    function zionFmtUsd(n) {
      if (n == null || !Number.isFinite(Number(n))) return '—';
      return '$' + Math.round(Number(n)).toLocaleString();
    }

    function zionRemainLabel(expiresAt) {
      if (!expiresAt) return '';
      const ms = expiresAt - Date.now();
      if (ms <= 0) return 'expired';
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      if (m >= 60) {
        const h = Math.floor(m / 60);
        return h + 'h ' + (m % 60) + 'm left';
      }
      if (m > 0) return m + 'm ' + s + 's left';
      return s + 's left';
    }

    function renderZionOpenTrades() {
      const el = document.getElementById('zion-open-trades');
      if (!el) return;
      const open = window._lastOpenPositions || [];
      const zionOpen = open.filter(function (p) {
        return (
          (p && p.entrySource === 'zion') ||
          (p && p.tradeProfileId === 'zion')
        );
      });
      if (!zionOpen.length) {
        el.innerHTML =
          '<div class="mint">No open Zion / KOL Scan positions. Overview still lists every trade.</div>';
        return;
      }
      el.innerHTML = zionOpen
        .map(function (p) {
          const pnl = Number(p.unrealizedPnlPct);
          const pnlTxt = Number.isFinite(pnl)
            ? (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%'
            : '—';
          const pnlColor =
            Number.isFinite(pnl) && pnl >= 0 ? 'var(--green,#4ade80)' : 'var(--red,#f87171)';
          const sellLabel = String(p.symbol || (p.mint || '').slice(0, 6)).replace(/'/g, "\\\\'");
          return (
            '<div class="zion-open-row">' +
            '<div>' +
            '<div class="flex flex-wrap gap-2 items-center">' +
            fmtTradeProfileBadge(p, { compact: false }) +
            '<strong style="color:#f1f5f9">' +
            escHtml(p.symbol || '?') +
            '</strong>' +
            '<span class="mint">' +
            zionFmtUsd(p.entryMarketCapUsd) +
            ' buy MC</span>' +
            '</div>' +
            '<div class="mint text-xs mt-1">' +
            escHtml(
              (p.tradeProfileReason ||
                'Triggered manually via Zion / KOL Scan').slice(0, 120)
            ) +
            '</div>' +
            '</div>' +
            '<div class="flex flex-wrap gap-2 items-center">' +
            '<span style="color:' +
            pnlColor +
            ';font-weight:700">' +
            pnlTxt +
            '</span>' +
            '<button class="danger text-xs" onclick="forceSellPosition(\\'' +
            escAttr(p.id) +
            '\\', \\'' +
            sellLabel +
            '\\')" title="Force sell">Sell</button>' +
            '</div>' +
            '</div>'
          );
        })
        .join('');
    }

    function renderZionFeeds(data) {
      const st = document.getElementById('zion-status');
      if (st && data) {
        const sc = data.scanner || {};
        const zs = data.status || {};
        st.textContent =
          (zs.enabled ? 'Zion ON' : 'Zion OFF') +
          ' · scanner ' + (sc.enabled ? 'ON' : 'OFF') +
          (sc.running ? ' (running)' : '') +
          ' · universe ' + (sc.universeSize || 0) +
          ' · candidates ' + (sc.candidateCount || 0) +
          ' · pending offers ' + (zs.pendingOffers || 0) +
          (sc.lastError ? ' · err: ' + sc.lastError : '');
      }
      const feed = document.getElementById('zion-scanner-feed');
      if (feed) {
        const cands = (data && data.candidates) || [];
        if (!cands.length) {
          feed.innerHTML =
            '<div class="mint">No KOL scanner candidates yet — enable Zion and wait for a poll.</div>';
        } else {
          feed.innerHTML = cands
            .map(function (c) {
              const kols = (c.kolWallets || [])
                .slice(0, 5)
                .map(function (w) {
                  return escHtml(w.name || (w.address || '').slice(0, 6));
                })
                .join(', ');
              const status = String(c.status || 'seen');
              const cardCls =
                'zion-cand-card' +
                (status === 'offered' ? ' is-offered' : '') +
                (status === 'skipped' ? ' is-skipped' : '');
              const linked =
                (c.offerId && findZionOffer(c.offerId)) ||
                findZionOfferByMint(c.mint);
              const linkedDisp = linked ? zionOfferDisplayStatus(linked) : null;
              const openBtn =
                linked && linkedDisp && linkedDisp.key === 'active'
                  ? '<button type="button" class="btn btn-primary text-xs" onclick="openZionOfferModal(\\'' +
                    escAttr(linked.id) +
                    '\\')" title="Re-open trade request popup">Open trade</button>'
                  : linked
                    ? '<button type="button" class="btn btn-secondary text-xs" onclick="openZionOfferModal(\\'' +
                      escAttr(linked.id) +
                      '\\')" title="View offer details">View</button>'
                    : '';
              const remain =
                linked && linkedDisp && linkedDisp.key === 'active'
                  ? '<span class="mint text-xs">' +
                    zionRemainLabel(linked.expiresAt) +
                    '</span>'
                  : '';
              return (
                '<div class="' +
                cardCls +
                '">' +
                '<div class="flex flex-wrap gap-2 items-center justify-between">' +
                '<div class="flex flex-wrap gap-2 items-center">' +
                '<span class="zion-cand-sym">' +
                escHtml(c.symbol || '?') +
                '</span>' +
                '<span class="zion-status-pill is-' +
                (status === 'offered'
                  ? 'active'
                  : status === 'skipped'
                    ? 'declined'
                    : 'approved') +
                '">' +
                escHtml(status) +
                '</span>' +
                '</div>' +
                '<div class="flex items-center gap-2">' +
                '<span class="zion-cand-chip is-score">◈ ' +
                Math.round(c.score || 0) +
                '</span>' +
                zionFoundAgoHtml(c.timestamp, 'Found') +
                '</div>' +
                '</div>' +
                '<div class="zion-cand-meta">' +
                (c.mcUsd != null
                  ? '<span class="zion-cand-chip">MC ' + zionFmtUsd(c.mcUsd) + '</span>'
                  : '') +
                (c.volumeH1Usd != null
                  ? '<span class="zion-cand-chip">Vol1h ' + zionFmtUsd(c.volumeH1Usd) + '</span>'
                  : '') +
                '<span class="zion-cand-chip">KOLs ' +
                (c.kolCount || 0) +
                '</span>' +
                (c.trackedBoostCount
                  ? '<span class="zion-cand-chip is-boost">tracked +' +
                    c.trackedBoostCount +
                    '</span>'
                  : '') +
                '</div>' +
                fmtMintCa(c.mint) +
                '<div class="mint text-xs mt-1">' +
                (kols || '—') +
                (c.skipReason ? ' · ' + escHtml(c.skipReason) : '') +
                '</div>' +
                (openBtn || remain
                  ? '<div class="zion-cand-actions">' + openBtn + remain + '</div>'
                  : '') +
                '</div>'
              );
            })
            .join('');
        }
      }
      const offersEl = document.getElementById('zion-offers-feed');
      if (offersEl) {
        const offers = (data && data.offers) || [];
        if (!offers.length) {
          offersEl.innerHTML = '<div class="mint">No trade requests yet.</div>';
        } else {
          offersEl.innerHTML = offers
            .map(function (o) {
              const disp = zionOfferDisplayStatus(o);
              const canOpen = true;
              const openBtn = canOpen
                ? '<button class="btn ' +
                  (disp.key === 'active' ? 'btn-primary' : 'btn-secondary') +
                  ' text-xs" onclick="openZionOfferModal(\\'' +
                  escAttr(o.id) +
                  '\\')">' +
                  (disp.key === 'active' ? 'Open' : 'View') +
                  '</button>'
                : '';
              const remain =
                disp.key === 'active' ? zionRemainLabel(o.expiresAt) : '';
              return (
                '<div class="zion-offer-row">' +
                '<div style="flex:1;min-width:0">' +
                '<div class="flex flex-wrap gap-2 items-center justify-between">' +
                '<div class="flex flex-wrap gap-2 items-center">' +
                '<strong style="color:#e2e8f0">' +
                escHtml(zionOfferTitle(o)) +
                '</strong>' +
                '<span class="zion-status-pill is-' +
                disp.key +
                '">' +
                escHtml(disp.label) +
                (o.declinedByUser && disp.key === 'declined' ? ' (user)' : '') +
                '</span>' +
                '<span class="mint">score ' +
                Math.round(o.score || 0) +
                '</span>' +
                '<span class="mint">KOLs ' +
                (o.kolCount || 0) +
                '</span>' +
                (remain ? '<span class="mint">' + remain + '</span>' : '') +
                '</div>' +
                zionFoundAgoHtml(o.createdAt, 'Request created') +
                '</div>' +
                fmtMintCa(o.mint) +
                '<div class="mint text-xs mt-1" style="display:flex;flex-wrap:wrap;gap:0.55rem">' +
                '<span>MC live ' +
                zionFmtUsd(o.liveMcUsd != null ? o.liveMcUsd : o.mcUsd) +
                ' · entry ' +
                zionFmtUsd(o.mcUsd) +
                '</span>' +
                '<span>Vol1h live ' +
                zionFmtUsd(
                  o.liveVolumeH1Usd != null ? o.liveVolumeH1Usd : o.volumeH1Usd
                ) +
                ' · entry ' +
                zionFmtUsd(o.volumeH1Usd) +
                '</span>' +
                '<span>Liq live ' +
                zionFmtUsd(
                  o.liveLiquidityUsd != null ? o.liveLiquidityUsd : o.liquidityUsd
                ) +
                ' · entry ' +
                zionFmtUsd(o.liquidityUsd) +
                '</span>' +
                '</div>' +
                '<div class="mint text-xs mt-1">' +
                escHtml((o.reasons || []).slice(0, 3).join(' · ') || o.source || '') +
                '</div>' +
                '</div>' +
                openBtn +
                '</div>'
              );
            })
            .join('');
        }
      }
      renderZionOpenTrades();
    }

    function ensureZionStack() {
      let stack = document.getElementById('zion-offer-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'zion-offer-stack';
        stack.className = 'zion-offer-stack';
        stack.setAttribute('aria-live', 'polite');
        stack.setAttribute('data-count', '0');
      }
      // Keep on body so fixed stacking is never clipped by tab/panel overflow.
      if (stack.parentElement !== document.body) {
        document.body.appendChild(stack);
      }
      return stack;
    }

    function layoutZionOfferStack(focusCard) {
      const stack = ensureZionStack();
      const cards = Array.prototype.slice.call(
        stack.querySelectorAll('.zion-offer-card:not(.is-leaving)')
      );
      const n = cards.length;
      stack.setAttribute('data-count', String(Math.min(5, Math.max(0, n))));
      // Prefer newest (last) fully into view; stack itself scrolls if needed.
      const target = focusCard && focusCard.parentNode === stack ? focusCard : cards[cards.length - 1];
      if (target) {
        try {
          stack.scrollTop = stack.scrollHeight;
          target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
        } catch (_) {
          stack.scrollTop = stack.scrollHeight;
        }
      }
    }

    function clearZionPopupTimer(id) {
      const t = _zionPopupTimers.get(id);
      if (!t) return;
      if (t.interval) clearInterval(t.interval);
      if (t.timeout) clearTimeout(t.timeout);
      _zionPopupTimers.delete(id);
    }

    function dismissZionOfferCard(id, opts) {
      opts = opts || {};
      clearZionPopupTimer(id);
      if (opts.remember !== false) {
        markZionOfferDismissedLocal(id);
      }
      const card = document.getElementById('zion-offer-card-' + id);
      if (!card) {
        if (_zionActiveOfferId === id) _zionActiveOfferId = null;
        layoutZionOfferStack();
        return;
      }
      const finish = function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        if (_zionActiveOfferId === id) _zionActiveOfferId = null;
        layoutZionOfferStack();
      };
      if (opts.immediate) {
        finish();
        return;
      }
      card.classList.add('is-leaving');
      setTimeout(finish, 280);
    }

    function closeZionOfferModal() {
      if (_zionActiveOfferId) {
        dismissZionOfferCard(_zionActiveOfferId);
        return;
      }
      const stack = document.getElementById('zion-offer-stack');
      if (!stack) return;
      const cards = stack.querySelectorAll('.zion-offer-card');
      cards.forEach(function (card) {
        const oid = card.getAttribute('data-offer-id');
        if (oid) dismissZionOfferCard(oid);
      });
    }

    function handleZionRefresh(data) {
      _zionCache = data;
      // Feed UI only when Zion tab is open; popups only for NEW offers while browsing.
      const panel = document.querySelector('[data-tab-panel="zion"]');
      const onZion = panel && !panel.classList.contains('hidden');
      if (onZion) {
        renderZionFeeds(data);
        if (!_zionFormHydrated && !_zionSaveInFlight) {
          fillZionForm(data.config || {});
        }
      } else {
        renderZionOpenTrades();
      }
      ensureZionStack();
      const pending = ((data && data.offers) || []).filter(function (o) {
        return zionOfferDisplayStatus(o).key === 'active';
      });
      // First payload after page load/refresh: seed known IDs — do NOT auto-popup.
      if (!_zionOffersBootstrapped) {
        for (let i = 0; i < pending.length; i++) {
          const o = pending[i];
          _zionShownOffers.add(o.id);
          if (o.popupDismissed) _zionDismissedOffers.add(o.id);
        }
        persistZionDismissedIds(_zionDismissedOffers);
        _zionOffersBootstrapped = true;
        // Still refresh open popup cards' live stats if any are visible
        pending.forEach(function (o) {
          const card = document.getElementById('zion-offer-card-' + o.id);
          if (card) applyZionOfferExpiryUi(card, o);
        });
        return;
      }
      for (let i = 0; i < pending.length; i++) {
        const o = pending[i];
        const card = document.getElementById('zion-offer-card-' + o.id);
        if (card) {
          applyZionOfferExpiryUi(card, o);
          continue;
        }
        if (_zionDismissedOffers.has(o.id) || o.popupDismissed) {
          _zionShownOffers.add(o.id);
          continue;
        }
        if (_zionShownOffers.has(o.id)) continue;
        _zionShownOffers.add(o.id);
        openZionOfferModal(o.id, o, { auto: true });
      }
    }

    async function loadZion() {
      const st = document.getElementById('zion-save-status');
      try {
        const data = await fetchJSON('/api/zion');
        _zionCache = data;
        fillZionForm(data.config || {});
        renderZionFeeds(data);
        if (st) st.textContent = 'Loaded';
      } catch (err) {
        if (st) st.textContent = err.message || String(err);
      }
    }

    async function saveZionConfig() {
      if (_zionSaveInFlight) return;
      _zionSaveInFlight = true;
      const st = document.getElementById('zion-save-status');
      if (st) st.textContent = 'Saving…';
      try {
        const enabledEl = document.getElementById('zion-enabled');
        const scannerEl = document.getElementById('zion-scanner-enabled');
        const autoEl = document.getElementById('zion-auto-offer');
        const boostEl = document.getElementById('zion-tracked-boost');
        const emailOfferEl = document.getElementById('zion-email-offer');
        const emailPlacedEl = document.getElementById('zion-email-placed');
        const useExitsEl = document.getElementById('zion-use-exits');
        const body = {
          enabled: !!(enabledEl && enabledEl.checked),
          scanner: {
            enabled: scannerEl ? !!scannerEl.checked : true,
            pollIntervalMs: Number(document.getElementById('zion-poll-ms') && document.getElementById('zion-poll-ms').value) || 30000,
            universeSize: Number(document.getElementById('zion-universe') && document.getElementById('zion-universe').value) || 60,
          },
          autoOfferFromScanner: autoEl ? !!autoEl.checked : true,
          useTrackedWalletsAsBoost: boostEl ? !!boostEl.checked : true,
          notifyEmailOnOffer: emailOfferEl ? !!emailOfferEl.checked : true,
          notifyEmailOnPlaced: emailPlacedEl ? !!emailPlacedEl.checked : true,
          minKolWallets: Number(document.getElementById('zion-min-kol') && document.getElementById('zion-min-kol').value) || 2,
          minWalletQuality: Number(document.getElementById('zion-min-quality') && document.getElementById('zion-min-quality').value) || 40,
          minMcUsd: Number(document.getElementById('zion-min-mc') && document.getElementById('zion-min-mc').value) || 50000,
          maxMcUsd: Number(document.getElementById('zion-max-mc') && document.getElementById('zion-max-mc').value) || 500000000,
          offerTtlMinutes: Number(document.getElementById('zion-ttl') && document.getElementById('zion-ttl').value) || 60,
          mintCooldownMinutes: Number(document.getElementById('zion-cooldown') && document.getElementById('zion-cooldown').value) || 120,
          defaults: {
            sizeMode: (document.getElementById('zion-size-mode') && document.getElementById('zion-size-mode').value) || 'sol',
            solAmount: Number(document.getElementById('zion-sol') && document.getElementById('zion-sol').value) || 0.25,
            usdAmount: Number(document.getElementById('zion-usd') && document.getElementById('zion-usd').value) || 50,
            takeProfitPct: Number(document.getElementById('zion-tp') && document.getElementById('zion-tp').value) || 80,
            stopLossPct: Number(document.getElementById('zion-sl') && document.getElementById('zion-sl').value) || -25,
            trailingStopPct: Number(document.getElementById('zion-trail') && document.getElementById('zion-trail').value) || 18,
            trailingActivationProfit: Number(document.getElementById('zion-trail-act') && document.getElementById('zion-trail-act').value) || 35,
            useExitPresets: useExitsEl ? !!useExitsEl.checked : true,
          },
        };
        const data = await fetchJSON('/api/config/zion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (data && data.config) {
          fillZionForm(data.config);
          _zionCache = Object.assign({}, _zionCache || {}, {
            config: data.config,
            scanner: data.scanner || (_zionCache && _zionCache.scanner) || {},
            status: Object.assign({}, (_zionCache && _zionCache.status) || {}, {
              enabled: data.config.enabled === true,
            }),
          });
          renderZionFeeds(_zionCache);
        } else {
          fillZionForm(body);
        }
        if (st) {
          st.textContent =
            'Saved' + (data && data.config && data.config.enabled ? ' · ON' : ' · OFF');
        }
      } catch (err) {
        if (st) st.textContent = err.message || String(err);
        alert(err.message || String(err));
      } finally {
        _zionSaveInFlight = false;
      }
    }

    function findZionOffer(id) {
      const offers = (_zionCache && _zionCache.offers) || [];
      return offers.find(function (o) { return o.id === id; }) || null;
    }

    function findZionOfferByMint(mint) {
      const m = String(mint || '').trim();
      if (!m) return null;
      const offers = (_zionCache && _zionCache.offers) || [];
      const pending = offers.find(function (o) {
        return o.mint === m && zionOfferDisplayStatus(o).key === 'active';
      });
      if (pending) return pending;
      return offers.find(function (o) { return o.mint === m; }) || null;
    }

    function zionExpireProgress(o) {
      const exp = Number(o && o.expiresAt) || 0;
      const created = Number(o && o.createdAt) || (exp ? exp - 60 * 60_000 : 0);
      const total = Math.max(1, exp - created);
      const left = exp - Date.now();
      return {
        leftMs: left,
        pct: Math.max(0, Math.min(1, left / total)),
        expired: left <= 0,
      };
    }

    function applyZionOfferExpiryUi(card, o) {
      if (!card || !o) return zionOfferDisplayStatus(o);
      const disp = zionOfferDisplayStatus(o);
      const progress = zionExpireProgress(o);
      const bar = card.querySelector('[data-zion-expire-bar]');
      const label = card.querySelector('[data-zion-expire-label]');
      const placeBtn = card.querySelector('[data-zion-place]');
      const declineBtn = card.querySelector('[data-zion-decline]');
      const title = card.querySelector('.zion-offer-title');
      const st = card.querySelector('[data-zion-status]');
      if (bar) bar.style.transform = 'scaleX(' + progress.pct.toFixed(4) + ')';
      if (label) {
        if (progress.expired || disp.key !== 'active') {
          label.textContent =
            disp.key === 'active' ? 'Offer expired' : 'Offer ' + disp.label.toLowerCase();
        } else {
          label.textContent = 'Expires in ' + zionRemainLabel(o.expiresAt).replace(/ left$/, '');
        }
      }
      if (title) {
        title.textContent = zionOfferTitle(o) + ' · ' + disp.label;
      }
      // Live MC / vol / liq + score / KOLs
      const liveMc = o.liveMcUsd != null ? o.liveMcUsd : o.mcUsd;
      const liveVol = o.liveVolumeH1Usd != null ? o.liveVolumeH1Usd : o.volumeH1Usd;
      const liveLiq = o.liveLiquidityUsd != null ? o.liveLiquidityUsd : o.liquidityUsd;
      const setStat = function (key, live, entry) {
        const el = card.querySelector('[data-zion-stat="' + key + '"]');
        if (!el) return;
        const liveEl = el.querySelector('[data-zion-live-val]');
        const entryEl = el.querySelector('[data-zion-entry-val]');
        if (liveEl) liveEl.textContent = zionFmtUsd(live);
        if (entryEl) entryEl.textContent = zionFmtUsd(entry);
      };
      setStat('MC', liveMc, o.mcUsd);
      setStat('Vol 1h', liveVol, o.volumeH1Usd);
      setStat('Liq', liveLiq, o.liquidityUsd);
      const scoreEl = card.querySelector('[data-zion-score]');
      if (scoreEl) scoreEl.textContent = String(Math.round(o.score || 0));
      const kolEl = card.querySelector('[data-zion-kol-count]');
      if (kolEl) kolEl.textContent = String(o.kolCount || 0);
      const kolList = card.querySelector('[data-zion-kol-list]');
      if (kolList) {
        kolList.innerHTML = (o.kolWallets || [])
          .map(function (w) {
            return (
              escHtml(w.name || 'KOL') +
              ' <span class="mint">(' +
              escHtml((w.address || '').slice(0, 8)) +
              '…)</span>'
            );
          })
          .join(' · ') || '—';
      }
      const reasonsEl = card.querySelector('[data-zion-reasons]');
      if (reasonsEl) {
        reasonsEl.textContent = (o.reasons || []).join(' · ') || '—';
      }
      const canPlace = disp.key === 'active' && !progress.expired;
      if (placeBtn) {
        if (canPlace) {
          placeBtn.disabled = false;
          placeBtn.classList.remove('is-expired', 'hidden');
          placeBtn.style.display = '';
          placeBtn.textContent = 'Place Trade';
        } else {
          placeBtn.disabled = true;
          placeBtn.classList.add('is-expired');
          placeBtn.textContent = 'Expired';
          placeBtn.style.display = 'none';
        }
      }
      if (declineBtn) {
        declineBtn.disabled = !canPlace;
        declineBtn.style.display = canPlace ? '' : 'none';
      }
      if (st && (progress.expired || disp.key !== 'active')) {
        const cur = String(st.textContent || '');
        if (!/Placed|Placing|fail|Declined/i.test(cur)) {
          st.textContent =
            disp.key === 'executed'
              ? 'Already placed'
              : disp.key === 'declined'
                ? 'Declined by user'
                : 'Offer ' +
                  disp.label.toLowerCase() +
                  ' — Place Trade unavailable';
        }
      }
      return disp;
    }

    function openZionOfferModal(id, offer, opts) {
      opts = opts || {};
      const o = offer || findZionOffer(id);
      if (!o) {
        fetchJSON('/api/zion/offers/' + encodeURIComponent(id) + '/open', { method: 'POST' })
          .then(function (res) {
            if (res.offer) openZionOfferModal(id, res.offer, opts);
          })
          .catch(function () {});
        return;
      }
      const disp = zionOfferDisplayStatus(o);
      _zionActiveOfferId = o.id;
      _zionShownOffers.add(o.id);
      const existing = document.getElementById('zion-offer-card-' + o.id);
      if (existing) {
        existing.classList.remove('is-leaving');
        applyZionOfferExpiryUi(existing, o);
        layoutZionOfferStack(existing);
        return;
      }

      const stack = ensureZionStack();
      const d = (_zionCache && _zionCache.config && _zionCache.config.defaults) || {};
      const solDef = d.solAmount != null ? d.solAmount : 0.25;
      const usdDef = d.usdAmount != null ? d.usdAmount : 50;
      const exitsOn = d.useExitPresets !== false;
      const kols = (o.kolWallets || [])
        .map(function (w) {
          return (
            escHtml(w.name || 'KOL') +
            ' <span class="mint">(' +
            escHtml((w.address || '').slice(0, 8)) +
            '…)</span>'
          );
        })
        .join(' · ');
      const canPlace = disp.key === 'active';

      const card = document.createElement('div');
      card.className = 'zion-offer-card';
      card.id = 'zion-offer-card-' + o.id;
      card.setAttribute('data-offer-id', o.id);
      card.innerHTML =
        '<div class="flex items-start justify-between gap-2">' +
        '<div>' +
        '<div class="zion-offer-kicker"><span aria-hidden="true">◈</span> Zion trade request</div>' +
        '<div class="zion-offer-title">' +
        escHtml(zionOfferTitle(o)) +
        ' · ' +
        escHtml(disp.label) +
        '</div>' +
        '</div>' +
        '<button type="button" class="btn btn-secondary text-xs" data-zion-dismiss="' +
        escAttr(o.id) +
        '">Close</button>' +
        '</div>' +
        '<div class="zion-countdown">' +
        '<div class="zion-countdown-row">' +
        '<span data-zion-expire-label>Expires in —</span>' +
        '<div class="zion-countdown-bar"><span data-zion-expire-bar style="transform:scaleX(1)"></span></div>' +
        '</div>' +
        (opts.auto
          ? '<div class="mint text-xs" data-zion-autohide-label>Popup auto-hides in 30s (offer stays Active)</div>'
          : '') +
        '</div>' +
        '<div class="zion-offer-stats">' +
        zionEntryLiveStatHtml('MC', o.mcUsd, o.liveMcUsd != null ? o.liveMcUsd : o.mcUsd) +
        zionEntryLiveStatHtml(
          'Vol 1h',
          o.volumeH1Usd,
          o.liveVolumeH1Usd != null ? o.liveVolumeH1Usd : o.volumeH1Usd
        ) +
        zionEntryLiveStatHtml(
          'Liq',
          o.liquidityUsd,
          o.liveLiquidityUsd != null ? o.liveLiquidityUsd : o.liquidityUsd
        ) +
        '</div>' +
        '<div class="zion-offer-body">' +
        '<div><span class="mint">Score</span> <span data-zion-score>' +
        Math.round(o.score || 0) +
        '</span> · <span class="mint">Source</span> ' +
        escHtml(o.source || '') +
        '</div>' +
        '<div class="mt-1"><span class="mint">Reasons</span> <span data-zion-reasons">' +
        escHtml((o.reasons || []).join(' · ') || '—') +
        '</span></div>' +
        '<div class="mt-1"><span class="mint">KOLs (<span data-zion-kol-count>' +
        (o.kolCount || 0) +
        '</span>)</span> <span data-zion-kol-list>' +
        (kols || '—') +
        '</span></div>' +
        '<div class="mt-2">' +
        fmtMintCa(o.mint) +
        '</div>' +
        '</div>' +
        '<div class="grid grid-cols-2 gap-2 mb-2">' +
        '<label class="ctl ctl-sm"><span>SOL amount</span><input type="number" data-zion-sol min="0.01" step="0.01" value="' +
        escAttr(String(solDef)) +
        '"' +
        (canPlace ? '' : ' disabled') +
        ' /></label>' +
        '<label class="ctl ctl-sm"><span>USD amount</span><input type="number" data-zion-usd min="1" step="1" value="' +
        escAttr(String(usdDef)) +
        '"' +
        (canPlace ? '' : ' disabled') +
        ' /></label>' +
        '</div>' +
        '<div class="toggle-row mb-2">' +
        '<span>Apply buy / TP / SL / trail presets</span>' +
        '<label class="switch"><input type="checkbox" data-zion-exits' +
        (exitsOn ? ' checked' : '') +
        (canPlace ? '' : ' disabled') +
        ' /><span class="slider"></span></label>' +
        '</div>' +
        '<div class="zion-offer-actions">' +
        '<button type="button" class="btn btn-primary' +
        (canPlace ? '' : ' is-expired') +
        '" style="background:#16a34a' +
        (canPlace ? '' : ';display:none') +
        '" data-zion-place="' +
        escAttr(o.id) +
        '"' +
        (canPlace ? '' : ' disabled') +
        '>' +
        (canPlace ? 'Place Trade' : 'Expired') +
        '</button>' +
        '<button type="button" class="btn btn-secondary" data-zion-decline="' +
        escAttr(o.id) +
        '"' +
        (canPlace ? '' : ' disabled style="display:none"') +
        '>Decline</button>' +
        '</div>' +
        '<div class="mint text-xs mt-2" data-zion-status>' +
        (canPlace
          ? 'Ready · reopen anytime from Zion feed while Active · Close hides popup only'
          : 'Offer ' + disp.label.toLowerCase() + ' — Place Trade unavailable') +
        '</div>';

      stack.appendChild(card);
      applyZionOfferExpiryUi(card, o);
      layoutZionOfferStack(card);

      const started = Date.now();
      const hideLabel = card.querySelector('[data-zion-autohide-label]');
      const tick = function () {
        const live = findZionOffer(o.id) || o;
        const cur = applyZionOfferExpiryUi(card, live);
        if (opts.auto && hideLabel) {
          const hideLeft = Math.max(0, ZION_POPUP_TTL_MS - (Date.now() - started));
          hideLabel.textContent =
            'Popup auto-hides in ' +
            Math.ceil(hideLeft / 1000) +
            's (offer stays Active)';
          if (hideLeft <= 0) {
            dismissZionOfferCard(o.id);
            return;
          }
        }
        if (cur.key !== 'active' && !opts.auto) {
          /* keep card open so user can still copy CA / read reasons */
        }
      };
      const interval = setInterval(tick, 250);
      let timeout = null;
      if (opts.auto) {
        timeout = setTimeout(function () {
          dismissZionOfferCard(o.id);
        }, ZION_POPUP_TTL_MS);
      }
      clearZionPopupTimer(o.id);
      _zionPopupTimers.set(o.id, { interval: interval, timeout: timeout });
      tick();

      // Manual open jumps to Zion; auto popups stay on the user's current tab.
      if (!opts.auto) {
        showTab('zion', document.querySelector('[data-tab="zion"]'));
      }
      try {
        fetchJSON('/api/zion/offers/' + encodeURIComponent(o.id) + '/open', {
          method: 'POST',
        }).catch(function () {});
      } catch (_) {}
    }

    async function declineZionOffer(id) {
      const offerId = id || _zionActiveOfferId;
      if (!offerId) {
        closeZionOfferModal();
        return;
      }
      try {
        await fetchJSON(
          '/api/zion/offers/' + encodeURIComponent(offerId) + '/decline',
          { method: 'POST' }
        );
      } catch (_) {}
      markZionOfferDismissedLocal(offerId);
      dismissZionOfferCard(offerId, { immediate: true, remember: false });
      loadZion();
    }

    async function placeZionTrade(id) {
      const offerId = id || _zionActiveOfferId;
      if (!offerId) return;
      const card = document.getElementById('zion-offer-card-' + offerId);
      const st = card && card.querySelector('[data-zion-status]');
      const live = findZionOffer(offerId);
      if (!live || zionOfferDisplayStatus(live).key !== 'active') {
        if (card && live) applyZionOfferExpiryUi(card, live);
        if (st) st.textContent = 'Offer expired — Place Trade unavailable';
        return;
      }
      if (st) st.textContent = 'Placing…';
      const placeBtn = card && card.querySelector('[data-zion-place]');
      if (placeBtn) placeBtn.disabled = true;
      try {
        const solEl = card && card.querySelector('[data-zion-sol]');
        const usdEl = card && card.querySelector('[data-zion-usd]');
        const exEl = card && card.querySelector('[data-zion-exits]');
        const body = {
          solAmount: Number(solEl && solEl.value) || undefined,
          usdAmount: Number(usdEl && usdEl.value) || undefined,
          useExitPresets: !(exEl && exEl.checked === false),
        };
        const mode =
          (_zionCache &&
            _zionCache.config &&
            _zionCache.config.defaults &&
            _zionCache.config.defaults.sizeMode) ||
          'sol';
        if (mode === 'usd') delete body.solAmount;
        else delete body.usdAmount;
        const res = await fetchJSON(
          '/api/zion/offers/' + encodeURIComponent(offerId) + '/approve',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        );
        if (!res.ok) throw new Error(res.error || 'Place trade failed');
        if (st) st.textContent = 'Placed — refreshing…';
        // Force-pull open positions so Overview / Zion Open Trades update even if
        // a background refresh() is in-flight and would otherwise no-op.
        try {
          const posData = await fetchJSON('/api/positions');
          window._lastOpenPositions = (posData && posData.open) || [];
          if (typeof paintOpenPositionsTables === 'function') {
            paintOpenPositionsTables();
          }
          renderZionOpenTrades();
        } catch (_) {}
        try {
          await loadZion();
        } catch (_) {}
        if (st) st.textContent = 'Placed';
        setTimeout(function () {
          dismissZionOfferCard(offerId);
        }, 600);
        // Kick a full dashboard refresh after the in-flight lock clears.
        setTimeout(function () {
          try {
            window._refreshInFlight = false;
            refresh();
          } catch (_) {}
        }, 750);
      } catch (err) {
        if (st) st.textContent = err.message || String(err);
        if (placeBtn) placeBtn.disabled = false;
      }
    }

    document.addEventListener('click', function (ev) {
      const t = ev.target;
      if (!t || !t.closest) return;
      const place = t.closest('[data-zion-place]');
      if (place) {
        placeZionTrade(place.getAttribute('data-zion-place'));
        return;
      }
      const decline = t.closest('[data-zion-decline]');
      if (decline) {
        declineZionOffer(decline.getAttribute('data-zion-decline'));
        return;
      }
      const dismiss = t.closest('[data-zion-dismiss]');
      if (dismiss) {
        dismissZionOfferCard(dismiss.getAttribute('data-zion-dismiss'));
      }
    });

    window.loadZion = loadZion;
    window.saveZionConfig = saveZionConfig;
    window.openZionOfferModal = openZionOfferModal;
    window.closeZionOfferModal = closeZionOfferModal;
    window.declineZionOfferModal = declineZionOffer;
    window.declineZionOffer = declineZionOffer;
    window.placeZionTrade = placeZionTrade;
    window.renderZionOpenTrades = renderZionOpenTrades;
    try {
      ensureZionStack();
      window.addEventListener('resize', function () {
        layoutZionOfferStack();
      });
    } catch (_) {}


    async function saveTechnicalLevelsConfig(silent) {
      const fibRaw = document.getElementById('tl-priority-fibs')?.value || '0.5,0.618';
      const secRaw = document.getElementById('tl-secondary-fibs')?.value || '0.382,0.786';
      const prioritizeFibLevels = String(fibRaw)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n));
      const secondaryFibLevels = String(secRaw)
        .split(',')
        .map((s) => Number(String(s).trim()))
        .filter((n) => Number.isFinite(n));
      const zoneWidth = Number(document.getElementById('tl-zone-width')?.value) || 2;
      const minTouches = Number(document.getElementById('tl-min-touches')?.value) || 2;
      await fetchJSON('/api/config/technical-levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sensitivity: document.getElementById('tl-sensitivity')?.value || 'medium',
          lookbackHours: Number(document.getElementById('tl-lookback-hours')?.value) || 4,
          lookbackHoursMin: Number(document.getElementById('tl-lookback-min')?.value) || 2,
          lookbackHoursMax: Number(document.getElementById('tl-lookback-max')?.value) || 6,
          pivotWindow: Number(document.getElementById('tl-pivot')?.value) || 2,
          clusterPct: zoneWidth,
          zoneWidthPct: zoneWidth,
          nearPct: Number(document.getElementById('tl-near-pct')?.value) || 2,
          minImpulsePct: Number(document.getElementById('tl-min-impulse')?.value) || 50,
          minTouchesForValid: minTouches,
          minTouchesForStrong: minTouches,
          prioritizeFibLevels,
          secondaryFibLevels,
          preferRecentImpulse: document.getElementById('tl-prefer-recent')
            ? document.getElementById('tl-prefer-recent').checked
            : true,
          fibTreatAsZones: document.getElementById('tl-fib-zones')
            ? document.getElementById('tl-fib-zones').checked
            : true,
          srLookbackHours: Number(document.getElementById('tl-sr-lookback-hours')?.value) || 2,
          srLookbackHoursMin: Number(document.getElementById('tl-sr-lookback-min')?.value) || 1,
          srLookbackHoursMax: Number(document.getElementById('tl-sr-lookback-max')?.value) || 4,
          swingStrength: document.getElementById('tl-swing-strength')?.value || 'medium',
          preferRecentSupport: document.getElementById('tl-prefer-recent-support')
            ? document.getElementById('tl-prefer-recent-support').checked
            : true,
          favourVolumeReaction: document.getElementById('tl-favour-volume')
            ? document.getElementById('tl-favour-volume').checked
            : true,
          requireBreakCloseInvalidation: document.getElementById('tl-break-close')
            ? document.getElementById('tl-break-close').checked
            : true,
          hardFilter: document.getElementById('tl-hard-filter')
            ? document.getElementById('tl-hard-filter').checked
            : false,
        }),
      });
      if (!silent) alert('Technical Levels settings saved');
      refresh();
    }

    async function saveChartPatternsConfig(silent) {
      const patIds = [
        'ascending_triangle', 'descending_triangle', 'trendline_break',
        'holder_distribution', 'capitulation',
      ];
      const patterns = {};
      patIds.forEach(function (id) {
        const el = document.getElementById('cp-pat-' + id);
        patterns[id] = { enabled: el ? el.checked : false };
      });
      await fetchJSON('/api/config/chart-patterns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sensitivity: document.getElementById('cp-sensitivity')?.value || 'medium',
          mode: document.getElementById('cp-mode')?.value || 'both',
          lookbackBars: Number(document.getElementById('cp-lookback')?.value) || 64,
          minConfidence: Number(document.getElementById('cp-min-conf')?.value) || 55,
          breakoutPct: Number(document.getElementById('cp-breakout')?.value) || 1.2,
          pullbackNearPct: Number(document.getElementById('cp-pullback-near')?.value) || 3,
          minPoleRunPct: Number(document.getElementById('cp-min-pole')?.value) || 25,
          maxFlagRangePct: Number(document.getElementById('cp-max-flag')?.value) || 18,
          minStructuredDropPct: Number(document.getElementById('cp-min-struct-drop')?.value) || 8,
          maxStructuredDropPct: Number(document.getElementById('cp-max-struct-drop')?.value) || 35,
          volumeDryupRatio: Number(document.getElementById('cp-vol-dry')?.value) || 0.55,
          volumeReturnRatio: Number(document.getElementById('cp-vol-return')?.value) || 1.35,
          holderDropPct: Number(document.getElementById('cp-holder-drop')?.value) || 8,
          capitulationDropPct: Number(document.getElementById('cp-capitulation')?.value) || 28,
          bearishPenalty: Number(document.getElementById('cp-bear-penalty')?.value) || 6,
          hardFilter: document.getElementById('cp-hard-filter')
            ? document.getElementById('cp-hard-filter').checked
            : false,
          blockOnBearish: document.getElementById('cp-block-bearish')
            ? document.getElementById('cp-block-bearish').checked
            : false,
          patterns: patterns,
        }),
      });
      if (!silent) alert('Chart Patterns settings saved');
      refresh();
    }

    async function saveScalperSuiteSettings() {
      const status = document.getElementById('suite-settings-status');
      try {
        await saveMicroScalperConfig(true);
        await saveMomentumBurstConfig(true);
        await savePostMigrationScalpConfig(true);
        await saveReversalScalpConfig(true);
        let maxPos = Number(document.getElementById('suite-max-pos')?.value) || 3;
        maxPos = Math.max(2, Math.min(3, maxPos));
        const deadHold = Number(document.getElementById('suite-dead-hold')?.value) || 4;
        await fetchJSON('/api/config/filters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ maxConcurrentPositions: maxPos }),
        });
        await fetchJSON('/api/config/risk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enableDeadVolumeExit: true,
            deadVolumeMinHoldMinutes: deadHold,
            deadVolumeConsecutiveHours: 1,
            deadVolumeUsdPerHour: 80,
          }),
        }).catch(() => null);
        if (status) status.textContent = 'Suite + member settings saved · maxPos=' + maxPos;
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
        alert('Save failed: ' + (err.message || String(err)));
      }
    }

    async function saveMevConfig(silent) {
      await fetchJSON('/api/mev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useJitoBundles: document.getElementById('useJitoBundles').checked,
          sandwichProtection: document.getElementById('sandwichProtection').checked,
          abortOnSandwichRisk: document.getElementById('abortOnSandwichRisk').checked,
          tipMultiplier: Number(document.getElementById('tipMultiplier').value),
          priorityFeeMultiplier: Number(document.getElementById('priorityFeeMultiplier').value),
          sandwichMaxRecentBuys: Number(document.getElementById('sandwichMaxRecentBuys').value),
          tipLamports: Number(document.getElementById('jitoTipLamports').value),
          jitoEnabled: document.getElementById('useJitoBundles').checked,
        }),
      });
      if (!silent) alert('MEV settings saved');
      refresh();
    }

    async function saveNotificationsConfig() {
      const status = document.getElementById('notify-status');
      try {
        if (status) status.textContent = 'Saving…';
        await fetchJSON('/api/config/notifications', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: !!(document.getElementById('notify-enabled') || {}).checked,
            email: ((document.getElementById('notify-email') || {}).value || '').trim(),
            lowEquitySol: Number((document.getElementById('notify-low-equity-sol') || {}).value) || 1,
            lowEquityEnabled: !!(document.getElementById('notify-low-equity') || {}).checked,
            insufficientFundsEnabled: !!(document.getElementById('notify-insufficient') || {}).checked,
            profitableCloseEnabled: !!(document.getElementById('notify-profit-close') || {}).checked,
          }),
        });
        if (status) status.textContent = 'Saved';
        window._cfgLoaded = false;
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
        alert('Save failed: ' + (err.message || String(err)));
      }
    }
    window.saveNotificationsConfig = saveNotificationsConfig;

    async function testNotificationEmail() {
      const status = document.getElementById('notify-status');
      try {
        if (status) status.textContent = 'Sending test…';
        await saveNotificationsConfig();
        const data = await fetchJSON('/api/notifications/test', { method: 'POST' });
        if (data && data.ok === false) throw new Error(data.error || 'Test failed');
        if (status) {
          status.textContent =
            'Test sent via ' + ((data && data.provider) || 'email');
        }
        alert(
          'Test email sent via ' +
            ((data && data.provider) || 'email') +
            ' — check inbox / spam for ' +
            (((document.getElementById('notify-email') || {}).value) || 'your address')
        );
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
        alert(
          'Test email failed: ' +
            (err.message || String(err)) +
            '\\n\\nOn Render → Environment, set RESEND_API_KEY (recommended) or SMTP_HOST / SMTP_USER / SMTP_PASS, then redeploy.'
        );
      }
    }
    window.testNotificationEmail = testNotificationEmail;

    async function saveStrategySettings(key) {
      try {
        if (key === 'wallet_convergence') {
          await saveFilterConfig(true);
          await saveSelectiveConfig(true);
        } else if (['migration_priority', 'near_migration_curve', 'early_curve_smart_money', 'rebuy_on_dip'].includes(key)) {
          await saveStrategyConfig(true);
        } else if (key === 'multi_factor_conviction') {
          await saveSelectiveConfig(true);
        } else if (key === 'dead_market_exit') {
          await saveRiskConfig(true);
        } else if (key === 'dynamic_position_sizing') {
          await saveTradeConfig(true);
          await saveRiskConfig(true);
        } else if (key === 'tiered_profit_taking') {
          await saveTradeConfig(true);
          await saveRiskConfig(true);
          await saveProfitStrategy(true);
        } else if (key === 'mev_protection') {
          await saveMevConfig(true);
        } else if (key === 'quick_scalper') {
          await saveQuickScalperConfig(true);
        } else if (key === 'micro_scalper') {
          await saveMicroScalperConfig(true);
        } else if (key === 'momentum_burst') {
          await saveMomentumBurstConfig(true);
        } else if (key === 'post_migration_scalp') {
          await savePostMigrationScalpConfig(true);
        } else if (key === 'reversal_scalp') {
          await saveReversalScalpConfig(true);
        } else if (key === 'post_run_dip') {
          await savePostRunDipConfig(true);
        } else if (key === 'technical_levels') {
          await saveTechnicalLevelsConfig(true);
        } else if (key === 'chart_patterns') {
          await saveChartPatternsConfig(true);
        } else {
          await saveFilterConfig(true);
        }
        window._cfgLoaded = false;
        await refresh();
        alert('Strategy settings saved');
      } catch (err) {
        alert('Save failed: ' + (err.message || String(err)));
      }
    }

    async function resetToDefaults() {
      const msg = document.getElementById('persist-reset-msg');
      if (!confirm(
        'Reset ALL saved settings to defaults?\\n\\n' +
        'This deletes data/config.json, wallets.json, paperBalance.json, and backtestHistory.json, ' +
        'then reloads code defaults (default wallets, paper balance, empty backtest history).\\n\\n' +
        'This cannot be undone.'
      )) return;
      if (msg) msg.textContent = 'Resetting…';
      try {
        const data = await fetchJSON('/api/config/reset-defaults', { method: 'POST' });
        if (msg) {
          msg.textContent =
            'Done — deleted ' + (data.deleted || []).length + ' file(s). Defaults restored.';
        }
        alert(data.message || 'Defaults restored');
        await refresh();
      } catch (err) {
        if (msg) msg.textContent = err.message || String(err);
        alert('Reset failed: ' + (err.message || String(err)));
      }
    }

    async function clearRiskHalt() {
      await fetchJSON('/api/risk/clear-halt', { method: 'POST' });
      refresh();
    }

    async function toggleWallet(address, enabled) {
      await fetchJSON('/api/wallets/' + encodeURIComponent(address), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
      });
      refresh();
    }

    async function removeWallet(address) {
      if (!confirm('Remove this wallet?')) return;
      await fetchJSON('/wallets/remove', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
      });
      refresh();
    }

    document.getElementById('add-wallet-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const category = fd.get('category') || 'smart';
      const tags = category === 'scalper' ? ['scalper'] : category === 'sniper' ? ['sniper'] : category === 'kol' ? ['kol'] : [];
      try {
        await fetchJSON('/wallets/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            address: fd.get('address'),
            category,
            tags,
            source: 'manual',
          }),
        });
        e.target.reset();
        refresh();
      } catch (err) { alert(err.message); }
    });

    document.getElementById('add-trading-wallet-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await fetchJSON('/api/trading-wallets', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: fd.get('name'),
            envVar: fd.get('envVar'),
            role: fd.get('role'),
          }),
        });
        e.target.reset();
        await loadTradingWallets();
      } catch (err) { alert(err.message); }
    });

    document.getElementById('wallet-search-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); searchWallets(); }
    });

    const discoverSourceEl = document.getElementById('discover-source');
    if (discoverSourceEl) {
      discoverSourceEl.addEventListener('change', () => {
        const box = document.getElementById('discover-manual-box');
        if (box) box.classList.toggle('hidden', discoverSourceEl.value !== 'manual');
      });
    }

    function wireStrategiesOnPopover() {
      const count = document.getElementById('strategies-count');
      const pop = document.getElementById('strategies-on-popover');
      if (!count || !pop || count.dataset.onPopoverWired === '1') return;
      count.dataset.onPopoverWired = '1';
      let pinned = false;
      const show = () => {
        pop.classList.remove('hidden');
        count.setAttribute('aria-expanded', 'true');
      };
      const hide = () => {
        pop.classList.add('hidden');
        count.setAttribute('aria-expanded', 'false');
      };
      const toggle = () => {
        pinned = !pinned;
        if (pinned) show();
        else hide();
      };
      count.addEventListener('mouseenter', () => { if (!pinned) show(); });
      count.addEventListener('focus', () => { if (!pinned) show(); });
      count.addEventListener('mouseleave', (e) => {
        if (pinned || pop.contains(e.relatedTarget)) return;
        hide();
      });
      count.addEventListener('blur', () => { if (!pinned) hide(); });
      count.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      });
      count.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        } else if (e.key === 'Escape') {
          pinned = false;
          hide();
        }
      });
      pop.addEventListener('mouseenter', () => show());
      pop.addEventListener('mouseleave', () => {
        if (!pinned) hide();
      });
      pop.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', (e) => {
        if (!pinned) return;
        if (count.contains(e.target) || pop.contains(e.target)) return;
        pinned = false;
        hide();
      });
    }

    loadTradingWallets();
    refreshDiscoveryStatus();
    try { onNansenPresetChange(); loadNansenCached(); } catch (_) {}
    loadStrategies();
    try { renderTuningChecklist(); wireTuningChecklistCollapse(); } catch (_) {}
    wireStrategiesOnPopover();
    try { loadLastOptimizerResult(); } catch (_) {}
    refresh();
    setInterval(refresh, 5000);
    setInterval(tickDashboardResetTimer, 1000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') paintDashboardResetTimer();
    });
    const savedTab = (() => { try { return localStorage.getItem('botDashboardTab'); } catch (_) { return null; } })();
    const normalizeTabName = function (name) {
      return name === 'strategies' ? 'settings' : name;
    };
    const tabNames = ['overview', 'zion', 'microbots', 'trades', 'wallets', 'signals', 'scanner', 'settings', 'backtester', 'config', 'logs'];
    const qs = (() => { try { return new URLSearchParams(window.location.search); } catch (_) { return null; } })();
    const qsTab = normalizeTabName(qs && qs.get('tab'));
    const qsOffer = qs && qs.get('offer');
    const rememberedTab = normalizeTabName(savedTab);
    const startTab = tabNames.includes(qsTab) ? qsTab : (tabNames.includes(rememberedTab) ? rememberedTab : 'overview');
    showTab(startTab, document.querySelector('[data-tab="' + startTab + '"]'));
    if (qsOffer) {
      setTimeout(function () { openZionOfferModal(qsOffer); }, 400);
    }
  </script>

</body>
</html>`;
