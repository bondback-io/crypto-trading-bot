/**
 * Dashboard HTML — served at /dashboard
 * Tabbed Tailwind UI (Overview / Wallets / Signals / Backtester / Config / Logs)
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
    .dot-running { background: #34d399; box-shadow: 0 0 8px #34d399; }
    .dot-paused { background: #fbbf24; }
    .dot-stopped { background: #f87171; }
    .badge { display: inline-block; padding: 2px 10px; border-radius: 9999px; font-size: 11px; font-weight: 700; }
    .badge-paper { background: #1d4ed833; color: #93c5fd; }
    .badge-live { background: #7f1d1d55; color: #fca5a5; }
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
    .chart-wrap { position: relative; height: 220px; width: 100%; }
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
    .ctl input, .ctl select {
      width: 100%;
      min-width: 4.5rem;
    }
    .ctl-sm { width: 4.75rem; }
    .ctl-md { width: 5.75rem; }
    .ctl-lg { width: 7.5rem; }
    .ctl-check {
      flex-direction: row;
      align-items: center;
      gap: 0.4rem;
      padding-top: 1.1rem;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
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
    button:not(.btn):not(.danger):not(.secondary):not(.warning) { background: #059669; color: white; border: 1px solid #059669; border-radius: 0.5rem; padding: 0.35rem 0.65rem; font-size: 12px; font-weight: 600; cursor: pointer; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 0.75rem; padding: 1rem; }
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
      padding: 1.1rem 1.15rem 1.15rem;
      overflow: hidden;
    }
    .card-open-positions::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      background: linear-gradient(180deg, #34d399, #38bdf8);
    }
    .card-open-positions .section-title-open {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      flex-wrap: wrap;
      margin-bottom: 0.9rem;
    }
    .card-open-positions .section-title-open .title-left {
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      flex-wrap: wrap;
    }
    .card-open-positions .section-title-open .title-text {
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #ecfdf5;
    }
    .card-open-positions .pos-count-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0.65rem;
      border-radius: 9999px;
      font-size: 11px;
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
    .card-open-positions .positions-scroll {
      overflow-x: auto;
      max-height: 22rem;
      overflow-y: auto;
      border-radius: 0.55rem;
      border: 1px solid rgba(51, 65, 85, 0.7);
      background: rgba(15, 23, 42, 0.55);
    }
    .card-open-positions #positions-table {
      min-width: 52rem;
      margin: 0;
    }
    .card-open-positions #positions-table thead th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: rgba(15, 23, 42, 0.96);
      color: #cbd5e1;
      border-bottom: 1px solid rgba(52, 211, 153, 0.25);
      padding: 0.65rem 0.55rem;
    }
    .card-open-positions #positions-table tbody td {
      padding: 0.65rem 0.55rem;
      border-bottom-color: rgba(51, 65, 85, 0.55);
    }
    .card-open-positions #positions-table tbody tr:hover {
      background: rgba(56, 189, 248, 0.06);
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
    .stat { font-size: 1.5rem; font-weight: 700; color: #34d399; }
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

    /* Help tooltips — hover/focus the ? icon */
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
      border: 1px solid #475569;
      text-transform: none;
      letter-spacing: 0;
      vertical-align: middle;
    }
    .tip::before { content: '?'; }
    .tip::after {
      content: attr(data-tip);
      position: absolute;
      left: 50%;
      bottom: calc(100% + 8px);
      transform: translateX(-50%);
      width: max-content;
      max-width: min(280px, 70vw);
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
      text-align: left;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity .12s ease;
      z-index: 80;
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
    .has-tip { cursor: help; }

    /* Token name → hover CA + copy / Jupiter */
    .token-ca {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      cursor: pointer;
      border-bottom: 1px dashed #475569;
    }
    .token-ca:hover { color: #7dd3fc; border-bottom-color: #38bdf8; }
    .token-ca .ca-pop {
      position: absolute;
      left: 0;
      bottom: calc(100% + 8px);
      z-index: 90;
      min-width: 240px;
      max-width: min(440px, 85vw);
      padding: 8px 10px;
      border-radius: 8px;
      background: #0f172a;
      border: 1px solid #38bdf8;
      box-shadow: 0 8px 24px rgba(0,0,0,.45);
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transition: opacity .12s ease;
    }
    .token-ca:hover .ca-pop,
    .token-ca:focus .ca-pop,
    .token-ca:focus-within .ca-pop {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }
    .token-ca .ca-pop .ca-label {
      font-size: 10px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 4px;
    }
    .token-ca .ca-pop .ca-addr {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: #e2e8f0;
      word-break: break-all;
      line-height: 1.35;
    }
    .token-ca .ca-pop .ca-hint {
      margin-top: 6px;
      font-size: 10px;
      color: #38bdf8;
    }
    .token-ca.copied .ca-pop .ca-hint { color: #34d399; }
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
    html { -webkit-text-size-adjust: 100%; }
    body { overflow-x: hidden; }
    .page-shell {
      width: 100%;
      max-width: 80rem;
      margin-left: auto;
      margin-right: auto;
      padding: 1rem 0.75rem 2.5rem;
    }
    .header-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 0.75rem 1rem;
      margin-bottom: 1rem;
    }
    .header-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem 0.5rem;
      flex: 1 1 16rem;
      max-width: 100%;
    }
    .header-actions .btn { flex: 0 0 auto; }
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
      scrollbar-width: thin;
      border-bottom: 1px solid transparent;
    }
    .nav-tabs::-webkit-scrollbar { height: 4px; }
    .nav-tabs::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
    .nav-tabs .btn {
      flex: 0 0 auto;
      white-space: nowrap;
      scroll-snap-align: start;
    }
    .overflow-x-auto {
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
      max-width: 100%;
    }
    .overflow-x-auto table {
      min-width: 36rem;
    }
    #bt-results-table { min-width: 64rem; }
    #positions-table { min-width: 54rem; }
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
    #wallets-table, #search-wallets-table, #discover-wallets-table { min-width: 48rem; }
    #discover-wallets-table th, #discover-wallets-table td,
    #wallets-table th, #wallets-table td,
    #search-wallets-table th, #search-wallets-table td {
      padding-left: 0.4rem;
      padding-right: 0.4rem;
      white-space: nowrap;
      font-size: 0.8rem;
    }
    #discover-wallets-table th, #wallets-table th, #search-wallets-table th {
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
      .header-bar { flex-direction: column; align-items: stretch; }
      .header-actions {
        flex: 1 1 auto;
        padding: 0.65rem !important;
      }
      .header-actions .btn {
        flex: 1 1 calc(50% - 0.35rem);
        justify-content: center;
        min-height: 2.5rem;
        padding: 0.5rem 0.55rem;
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
      .ctl input, .ctl select { min-width: 0; }
      .toggle-row {
        gap: 0.75rem;
        padding: 0.65rem 0;
        font-size: 13px;
      }
      .chart-wrap { height: 180px; }
      .tip::after {
        left: 0;
        transform: none;
        max-width: min(260px, calc(100vw - 2rem));
      }
      .token-ca .ca-pop {
        left: 0;
        right: auto;
        max-width: min(320px, calc(100vw - 2rem));
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
      .page-shell { padding: 1.1rem 1rem 2.25rem; }
      .btn-label-short { display: none; }
      .btn-label-full { display: inline; }
      .nav-tabs { flex-wrap: wrap; overflow-x: visible; }
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
        padding: 1.5rem 1.5rem 3rem;
      }
      .btn-label-short { display: none; }
      .btn-label-full { display: inline; }
      .nav-tabs {
        flex-wrap: wrap;
        overflow-x: visible;
        gap: 0.5rem;
        padding: 0.65rem 0.15rem;
      }
      .nav-tabs .btn { min-height: 2.25rem; padding: 0.5rem 0.9rem; }
      .header-actions { flex: 0 1 auto; max-width: none; }
      .card { padding: 1.15rem; }
      .filters-row { gap: 0.65rem 0.75rem; }
      .chart-wrap { height: 240px; }
      .section-title { margin-bottom: 0.85rem; }
    }

    /* Wide desktop */
    @media (min-width: 1400px) {
      .page-shell {
        max-width: 96rem;
        padding-left: 2rem;
        padding-right: 2rem;
      }
    }

    /* Prefer reduced motion */
    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; scroll-behavior: auto !important; }
    }

    /* Safe area (notched phones) */
    @supports (padding: max(0px)) {
      .page-shell {
        padding-left: max(0.75rem, env(safe-area-inset-left));
        padding-right: max(0.75rem, env(safe-area-inset-right));
        padding-bottom: max(2rem, env(safe-area-inset-bottom));
      }
      .nav-tabs { top: env(safe-area-inset-top, 0px); }
    }

    /* Override inline chart heights on small screens */
    @media (max-width: 639px) {
      .chart-wrap { height: 170px !important; }
      #logs-full, #system-logs { max-height: 55vh !important; }
      #activity { max-height: 14rem !important; }
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
      <div class="min-w-0">
        <div class="flex items-baseline gap-2 flex-wrap">
          <h1 class="text-xl sm:text-2xl lg:text-3xl font-bold text-sky-400 tracking-tight">Smart Money Copy Bot</h1>
          <span id="app-version" class="text-[10px] sm:text-xs text-slate-500 font-mono whitespace-nowrap has-tip" title="App version and last update">v—</span>
        </div>
        <p class="text-slate-500 text-xs sm:text-sm mt-0.5">Pump.fun · migrations · anti-rug · snipers</p>
      </div>
      <div class="header-actions card !py-2 !px-3">
        <span id="status-dot" class="dot dot-running" title="Monitor status: green=running, yellow=paused, red=stopped"></span>
        <strong id="status-text" class="text-sm has-tip" title="Whether the copy-trading monitor is actively polling wallets">Running</strong>
        <span id="mode-badge" class="badge badge-paper has-tip" title="PAPER = simulated fills. LIVE = real swaps with trading wallet keys">PAPER</span>
        <span class="text-slate-500 text-xs hidden sm:inline">·</span>
        <span class="text-xs text-slate-400 has-tip" title="Current paper or live wallet SOL balance">Bal <strong id="balance" class="text-slate-100">—</strong></span>
        <span class="text-xs text-slate-400 has-tip" title="Realized PnL for the current UTC day">PnL <strong id="daily-pnl" class="text-slate-100">—</strong></span>
        <span class="text-xs text-slate-400 hidden md:inline has-tip" title="Active Solana RPC endpoint label">RPC <strong id="rpc-active" class="text-slate-100">—</strong></span>
        <span class="text-xs text-slate-400 hidden md:inline has-tip" title="Last measured RPC latency"><strong id="rpc-latency">—</strong></span>
        <button id="btn-pause" class="btn btn-warning" onclick="togglePause()" title="Pause or resume the monitor without shutting down the bot">Pause</button>
        <button class="btn btn-secondary" onclick="forceRefreshMonitoring()" title="Re-enable all tracked wallets and re-subscribe the poll loop"><span class="btn-label-short">Refresh</span><span class="btn-label-full">Force Refresh Monitoring</span></button>
        <button onclick="setMode('paper')" class="btn btn-secondary" title="Switch to paper trading — no real funds risked">Paper</button>
        <button onclick="setMode('live')" class="btn btn-danger" title="Switch to live trading — real SOL will be spent. Confirm carefully.">Live</button>
      </div>
    </div>

    <!-- Tabs -->
    <nav class="nav-tabs" aria-label="Dashboard sections">
      <button data-tab="overview" onclick="showTab('overview', this)" class="btn bg-emerald-600 text-white text-xs sm:text-sm" title="Dashboard home: balance, positions, PnL charts, paper funding">Overview</button>
      <button data-tab="wallets" onclick="showTab('wallets', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Discover, search, and manage smart wallets you copy"><span class="btn-label-short">Wallets</span><span class="btn-label-full">Smart Wallets</span></button>
      <button data-tab="signals" onclick="showTab('signals', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Live Pump.fun activity, buy signals, migrations, and re-buy watches"><span class="btn-label-short">Signals</span><span class="btn-label-full">Signals &amp; Trades</span></button>
      <button data-tab="backtester" onclick="showTab('backtester', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Simulate strategies on historical launches with filters and charts">Backtester</button>
      <button data-tab="config" onclick="showTab('config', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Trade size, TP/SL, anti-rug filters, strategy toggles, risk, and MEV">Config</button>
      <button data-tab="logs" onclick="showTab('logs', this)" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" title="Trade events and system/API error logs for debugging">Logs</button>
    </nav>

    <!-- ========== TAB: Overview ========== -->
    <section data-tab-panel="overview" class="space-y-4">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
        <div class="card"><div class="stat-label">Balance <span class="tip tip-below" tabindex="0" data-tip="Available SOL for new buys (paper balance or live trading wallet)."></span></div><div class="stat" id="ov-balance-mirror">—</div><div class="mint mt-1">Daily <span id="ov-daily-mirror">—</span></div></div>
        <div class="card"><div class="stat-label">Open Positions <span class="tip tip-below" tabindex="0" data-tip="How many tokens you currently hold waiting for TP, SL, or trailing exit."></span></div><div class="stat" id="open-count">—</div></div>
        <div class="card"><div class="stat-label">Net PnL <span class="tip tip-below" tabindex="0" data-tip="Sum of realized profit/loss from closed trades this session/day."></span></div><div class="stat" id="stat-pnl">—</div><div class="mint mt-1" id="stat-return">—</div></div>
        <div class="card"><div class="stat-label">Win Rate <span class="tip tip-below" tabindex="0" data-tip="Percentage of closed trades that finished green."></span></div><div class="stat" id="win-rate">—</div><div class="mint mt-1" id="stat-wl">—</div></div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
        <div class="card"><div class="stat-label">Profit Factor <span class="tip tip-below" tabindex="0" data-tip="Gross wins ÷ gross losses. Above 1.0 means net profitable; 2.0+ is strong."></span></div><div class="stat" id="stat-pf">—</div><div class="mint mt-1" id="stat-pf-hint">—</div></div>
        <div class="card"><div class="stat-label">Max Drawdown <span class="tip tip-below" tabindex="0" data-tip="Worst peak-to-trough equity drop across closed trades."></span></div><div class="stat" id="stat-maxdd">—</div><div class="mint mt-1" id="stat-avg-hold">—</div></div>
        <div class="card !py-3">
          <div class="stat-label">Wallets <span class="tip tip-below" tabindex="0" data-tip="Watching = polled for copy signals. Tracked = total imported smart wallets."></span></div>
          <div class="text-lg font-semibold" id="watched">—</div>
          <div class="mint mt-1 text-xs" id="watched-sub">—</div>
        </div>
        <div class="card !py-3"><div class="stat-label">Signals <span class="tip tip-below" tabindex="0" data-tip="Wallet buy signals recorded in the last 24 hours (not capped by the recent activity list)."></span></div><div class="text-lg font-semibold" id="signals">—</div></div>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 sm:gap-3">
        <div class="card !py-3"><div class="stat-label">Trades <span class="tip tip-below" tabindex="0" data-tip="Open + closed paper/live trades. Closed count is shown in Closed Trades below."></span></div><div class="text-lg font-semibold" id="stat-trades">—</div></div>
        <div class="card !py-3"><div class="stat-label">Trade Rate <span class="tip tip-below" tabindex="0" data-tip="Buys in the last hour vs selective cap."></span></div><div class="text-lg font-semibold" id="stat-trade-rate">—</div></div>
        <div class="card !py-3 col-span-2"><div class="stat-label">Status <span class="tip tip-below" tabindex="0" data-tip="Short health summary: monitor state, mode, and key blockers."></span></div><div class="text-sm text-slate-300 break-words" id="stat-detail">—</div></div>
      </div>

      <div class="card">
        <div class="section-title">Risk Level <span class="tip" tabindex="0" data-tip="Preset that auto-tunes position size, filters, stops, drawdown limits, and selective entry gates."></span></div>
        <div class="flex flex-wrap gap-2 items-center mb-2" id="risk-level-toggle">
          <button type="button" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" id="risk-lvl-low" onclick="setRiskLevel('low')" title="Tight filters, smaller size, stricter stops">Low</button>
          <button type="button" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" id="risk-lvl-medium" onclick="setRiskLevel('medium')" title="Balanced recommended default">Medium</button>
          <button type="button" class="btn bg-slate-800 text-slate-300 text-xs sm:text-sm" id="risk-lvl-high" onclick="setRiskLevel('high')" title="Aggressive — larger size, looser filters">High</button>
          <span class="mint self-center" id="risk-level-label">—</span>
        </div>
        <div id="risk-level-warning" class="hidden text-amber-300 text-sm mb-2 font-medium"></div>
        <div class="mint text-sm" id="risk-level-summary">—</div>
        <div class="mint mt-2" id="risk-status">—</div>
      </div>

      <div class="card card-open-positions" id="open-positions-panel">
        <div class="section-title-open">
          <div class="title-left">
            <span class="title-text">Open Positions</span>
            <span class="tip" tabindex="0" data-tip="Active holdings with buy MC, cost (SOL + USD), 1h volume, unrealized PnL, trailing stop, take-profit, and stop-loss. Use Sell to force-close the full position. Low 1h volume can trigger dead-market force-sell."></span>
          </div>
          <span class="pos-count-badge" id="open-positions-badge" data-empty="1">0 open</span>
        </div>
        <div class="positions-scroll">
          <table id="positions-table">
            <thead><tr><th>Token</th><th>Name</th><th>Mint</th><th>Buy MC</th><th>Cost</th><th>1h vol</th><th>PnL</th><th>Trailing stop</th><th>TP</th><th>SL</th><th>Opened</th><th></th></tr></thead>
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
          <div class="section-title">Closed Trades <span class="tip" tabindex="0" data-tip="Finished trades with buy/exit MC, exit reason (TP, SL, trail, manual, migration, etc.)."></span></div>
          <div class="overflow-x-auto max-h-56 overflow-y-auto">
            <table id="closed-table">
              <thead><tr><th>Token</th><th>Name</th><th>Buy MC</th><th>Exit MC</th><th>PnL</th><th>Reason</th><th>Closed</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
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
          <div class="section-title">Migrations / Re-Buy <span class="tip" tabindex="0" data-tip="Pump.fun graduations to Raydium/PumpSwap and dip re-entry watches after take-profit."></span></div>
          <div class="mint mb-2" id="mig-live-status">WS: —</div>
          <div id="migrations" class="max-h-28 overflow-y-auto text-sm mb-2"></div>
          <div class="mint" id="rebuy-status">—</div>
        </div>
      </div>
    </section>

    <!-- ========== TAB: Smart Wallets ========== -->
    <section data-tab-panel="wallets" class="hidden space-y-4">
      <div class="card">
        <div class="flex flex-wrap gap-3 items-center justify-between mb-2">
          <div class="section-title !mb-0">Discovery Status <span class="tip" tabindex="0" data-tip="Health of wallet discovery APIs (GMGN/Kolscan/Birdeye): last fetch, errors, and auto-refresh interval."></span></div>
          <span class="mint" id="discovery-status">—</span>
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
          <button class="btn btn-secondary" onclick="refreshDiscoveryStatus()" title="Poll discovery health without starting a full search">Refresh status</button>
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
              <option value="30d">30D</option>
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
          <span class="mint" id="gmgn-status"></span>
        </div>
        <div class="mint text-sm mb-2" id="watching-status">Watching — wallets</div>
        <div id="watching-list" class="mint text-xs mb-3 max-h-24 overflow-y-auto" style="color:#94a3b8"></div>
        <div class="overflow-x-auto">
          <table id="wallets-table">
            <thead><tr><th>Name</th><th title="smart / scalper / sniper / kol">Cat</th><th>Address</th><th title="Absolute last trade time + relative label">Last Active</th><th>Win%</th><th title="7d / 30d / Pump.fun trades">7d / 30d / Pump</th><th>Status</th><th>Watch</th><th></th></tr></thead>
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
        <div class="section-title">Re-Buy Watch <span class="tip" tabindex="0" data-tip="After a take-profit, watches for a dip + confirmation buys from smart wallets before re-entering."></span></div>
        <div class="overflow-x-auto">
          <table id="rebuy-table">
            <thead><tr><th>Token</th><th>Status</th><th title="Current dip from peak">Dip</th><th title="Confirming smart wallets">Wallets</th><th>Volume</th><th>Reason</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
      <div class="card">
        <div class="section-title">Recent Migrations <span class="tip" tabindex="0" data-tip="Tokens graduating off Pump.fun bonding curve onto Raydium/PumpSwap — often high-priority entries."></span></div>
        <div class="mint mb-1" id="mig-live-status-signals">Live feed is on Overview · open that tab for WS status</div>
        <p class="text-sm text-slate-400">Migration events, re-buy watches, and open positions update live from the same APIs.</p>
      </div>
      <div class="card">
        <div class="section-title">Trade Log Preview <span class="tip" tabindex="0" data-tip="Short feed of recent buys/sells. Full history is on the Logs tab."></span></div>
        <div id="logs" class="max-h-48 overflow-y-auto"></div>
      </div>
    </section>

    <!-- ========== TAB: Backtester ========== -->
    <section data-tab-panel="backtester" class="hidden space-y-4">
      <div class="card">
        <div class="section-title">Advanced Backtester <span class="tip" tabindex="0" data-tip="Replay your strategy on recent launches with filters. Paper-only — no live orders."></span></div>
        <div class="mb-3 p-3 rounded-lg text-sm" style="background:#0f172a;border:1px solid #334155;color:#94a3b8">
          <strong style="color:#e2e8f0">Backtest uses your risk presets + selective entry gates</strong>
          <span class="mint block mt-1" id="bt-config-banner">Applies conviction score, wallet convergence, rate limits, max concurrent, and filter floors from the selected risk level. Compare Low/Med/High to see differentiated trade counts and WR.</span>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl ctl-md"><span>Lookback hours <span class="tip" tabindex="0" data-tip="How far back to pull launch data (1–168 hours)."></span></span><input type="number" id="bt-hours" value="24" min="1" max="168" /></label>
          <label class="ctl ctl-md"><span>Max trades <span class="tip" tabindex="0" data-tip="Soft cap on simulated entries. Selective rate limits + risk level may take fewer."></span></span><input type="number" id="bt-max" value="12" min="1" max="80" /></label>
          <label class="ctl ctl-md"><span>Simulations <span class="tip" tabindex="0" data-tip="Repeat the run N times (useful when synthetic noise is allowed)."></span></span><input type="number" id="bt-sims" value="1" min="1" max="20" /></label>
          <label class="ctl ctl-md"><span>Start SOL <span class="tip" tabindex="0" data-tip="Starting paper bankroll for the simulation."></span></span><input type="number" id="bt-start-bal" value="10" min="0.5" max="100" step="0.5" /></label>
          <label class="ctl ctl-lg"><span>Strategy <span class="tip" tabindex="0" data-tip="Auto = bot defaults. Convergence = multi-wallet. Migration = grads only. Single = first wallet buy."></span></span>
            <select id="bt-strategy">
              <option value="auto">Auto</option>
              <option value="convergence">Convergence</option>
              <option value="migration">Migration plays</option>
              <option value="single">Single wallet</option>
            </select>
          </label>
          <label class="ctl ctl-lg"><span>Risk level for this run only <span class="tip" tabindex="0" data-tip="Overrides riskLevel for this backtest only (not saved). Current = your live saved settings. Low/Med/High apply that preset temporarily then restore."></span></span>
            <select id="bt-risk-level">
              <option value="current" selected>Current saved</option>
              <option value="low">Override → Low</option>
              <option value="medium">Override → Medium</option>
              <option value="high">Override → High</option>
            </select>
          </label>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl ctl-md"><span>Min liquidity $ <span class="tip" tabindex="0" data-tip="Skip tokens below this liquidity."></span></span><input type="number" id="bt-min-liq" value="0" min="0" step="1000" /></label>
          <label class="ctl ctl-md"><span>Min MC $ <span class="tip" tabindex="0" data-tip="Skip tokens below this market cap at entry."></span></span><input type="number" id="bt-min-mc" value="0" min="0" step="1000" /></label>
          <label class="ctl ctl-md"><span>Min volume $ <span class="tip" tabindex="0" data-tip="Skip tokens below this 24h volume."></span></span><input type="number" id="bt-min-vol" value="0" min="0" step="1000" /></label>
          <label class="ctl ctl-md"><span>Max risk score <span class="tip" tabindex="0" data-tip="0 = no filter. Otherwise skip tokens with risk above this (0–100)."></span></span><input type="number" id="bt-max-risk" value="0" min="0" max="100" step="5" /></label>
        </div>
        <div class="filters-row mb-3">
          <label class="ctl-check" title="Use live DexScreener/GMGN market data when available"><input type="checkbox" id="bt-live" checked /> Live data</label>
          <label class="ctl-check" title="Only simulate Pump.fun → DEX graduation plays"><input type="checkbox" id="bt-mig-only" /> Migration plays only</label>
          <label class="ctl-check" title="Only include Pump.fun / pump-tagged launches"><input type="checkbox" id="bt-pump-only" /> Pump.fun only</label>
          <label class="ctl-check" title="Allow dip re-entry after take-profit in the sim"><input type="checkbox" id="bt-rebuy" /> Re-buy enabled</label>
          <label class="ctl-check" title="If live data is thin, generate synthetic price paths so the sim still runs"><input type="checkbox" id="bt-synthetic" checked /> Allow synthetic</label>
          <label class="ctl-check" title="Also run Low, Medium, and High on the same events for side-by-side comparison (does not change live settings)"><input type="checkbox" id="bt-compare-risk" /> Compare Low / Med / High</label>
        </div>
        <div id="bt-config-used" class="mint text-sm mb-2 hidden"></div>
        <div class="flex flex-wrap gap-2 items-center mb-2">
          <button class="btn btn-primary" id="bt-run-btn" onclick="runBacktest()" title="Start the simulation with current filters">Run Backtest</button>
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
        <div class="section-title">Performance Metrics <span class="tip" tabindex="0" data-tip="Key backtest KPIs after fees/slippage. Profit factor = gross wins ÷ gross losses. Sharpe = mean trade return ÷ std (not annualized). Max DD is equity-curve peak-to-trough. Check Compare Low/Med/High to add a risk-level breakdown."></span></div>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-3 mb-3">
          <div class="card !py-3 !bg-slate-900/50"><div class="stat-label">Win Rate</div><div class="stat" id="bt-stat-wr">—</div><div class="mint mt-1" id="bt-stat-wr-sub">—</div></div>
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

        <div id="bt-risk-compare" class="hidden">
          <div class="section-title !text-sm">Risk Level Breakdown <span class="tip" tabindex="0" data-tip="Enable Compare Low / Med / High on the run controls to populate this table and chart. Does not change live settings."></span></div>
          <p class="mint text-xs mb-2">Enable <strong>Compare Low / Med / High</strong> above, then re-run to compare the same events across risk presets.</p>
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
          <div class="chart-empty mint" id="bt-chart-risk-empty">No risk comparison yet — check Compare Low / Med / High and run</div>
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

      <div class="card">
        <div class="section-title">Trade Results (PnL SOL/USD · staged takes · wallet MC · delay) <span class="tip" tabindex="0" data-tip="PnL shows SOL and USD. Takes chips show whether partial / recovered initial happened before the remainder. Green/red row tint = win/loss. Hover Reason for full exit explanation."></span></div>
        <div class="overflow-x-auto max-h-[28rem] overflow-y-auto">
          <table id="bt-results-table">
            <thead>
              <tr>
                <th title="Hover token to show contract address · click to copy">Token</th>
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
              <tr><td colspan="15" class="text-slate-500">No backtest results yet</td></tr>
            </tbody>
          </table>
        </div>
        <details class="mt-3" id="bt-debug-panel">
          <summary class="mint cursor-pointer text-sm">Exit debug log (TP / SL / trail reasons)</summary>
          <pre id="bt-debug-log" class="mt-2 p-3 rounded text-xs overflow-x-auto max-h-64 overflow-y-auto" style="background:#0f172a;border:1px solid #334155;color:#94a3b8;white-space:pre-wrap">Run a backtest to see step-by-step exit reasons (e.g. Sold at +45% due to trailing stop).</pre>
        </details>
      </div>
    </section>

    <!-- ========== TAB: Config ========== -->
    <section data-tab-panel="config" class="hidden space-y-4">
      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Trade Settings <span class="tip" tabindex="0" data-tip="Default buy size and take-profit / stop-loss band applied to new positions."></span></div>
          <div class="form-grid grid grid-cols-1 sm:grid-cols-2 gap-3" id="trade-config">
            <div class="field">
              <label title="Base SOL per copy buy before risk/conviction scaling">Base Trade (SOL) — <span class="val" id="v-tradeAmountSol">0.12</span></label>
              <input type="range" id="tradeAmountSol" min="0.01" max="2" step="0.01" value="0.12" />
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
              <label title="Hard ceiling — with profit strategy ON this caps full exit before trail; trail can still run the bag past this until stop hits">Max Profit % — <span class="val" id="v-maxProfitPercent">500</span></label>
              <input type="range" id="maxProfitPercent" min="20" max="500" step="5" value="500" />
            </div>
            <div class="field">
              <label title="Hard stop-loss % from entry (negative)">Stop Loss % — <span class="val" id="v-stopLossPercent">-35</span></label>
              <input type="range" id="stopLossPercent" min="-80" max="-5" step="5" value="-35" />
            </div>
          </div>
          <p class="mint mt-2">Dynamic size = base × risk factor × conviction factor (± migration). High risk → closer to risk multiplier; high conviction → up to conviction multiplier.</p>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveTradeConfig()" title="Persist trade size and TP/SL settings">Save Trade</button></div>
        </div>

        <div class="card">
          <div class="section-title">Profit Strategy <span class="tip" tabindex="0" data-tip="Tiered exits: partial at a milestone → recover initial investment → leave a bag running with a trailing stop. Max Profit % above is the hard ceiling."></span></div>
          <p class="text-sm text-slate-400 mb-2">
            Flow: <strong>partial</strong> at milestone → <strong>recover initial</strong> → keep a <strong>bag</strong> → <strong>trail</strong> after high profit. Backtester uses the same rules.
          </p>
          <div class="toggle-row"><span title="Master switch for advanced tiered profit-taking (overrides simple TP when on)">Enable profit strategy</span><label class="switch"><input type="checkbox" id="ps-enabled" checked /><span class="slider"></span></label></div>
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
          <div class="section-title">Paper Prices <span class="tip" tabindex="0" data-tip="When on, paper positions mark-to-market with live prices. Full sims are in Backtester."></span></div>
          <p class="text-sm text-slate-400 mb-2">Advanced simulation lives in the <strong>Backtester</strong> tab.</p>
          <div class="toggle-row"><span title="Update open paper positions using live price feeds">Paper live prices</span><label class="switch"><input type="checkbox" id="paper-live-data" checked /><span class="slider"></span></label></div>
          <div class="flex flex-wrap gap-2 mt-2">
            <button class="btn btn-secondary" onclick="togglePaperLiveData()" title="Save the paper live-prices toggle">Save Live Price</button>
            <button class="btn btn-primary" onclick="showTab('backtester', document.querySelector('[data-tab=backtester]'))">Open Backtester</button>
            <span class="mint" id="paper-live-status"></span>
          </div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Filters &amp; Anti-Rug <span class="tip" tabindex="0" data-tip="Gates that must pass before a buy: convergence, liquidity, holder risk, honeypot, snipers."></span></div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="field"><label title="Distinct smart wallets that must buy before you copy">Convergence — <span class="val" id="v-convergenceRequired">2</span></label><input type="range" id="convergenceRequired" min="1" max="5" step="1" value="2" /></div>
            <div class="field"><label title="Max open positions at once">Max Positions — <span class="val" id="v-maxConcurrentPositions">5</span></label><input type="range" id="maxConcurrentPositions" min="1" max="20" step="1" value="5" /></div>
            <div class="field"><label title="Stop new buys after this much daily realized loss">Daily Loss SOL — <span class="val" id="v-dailyLossLimitSol">2</span></label><input type="range" id="dailyLossLimitSol" min="0.5" max="20" step="0.5" value="2" /></div>
            <div class="field"><label title="Skip source wallets below this win rate (0 = off)">Min Win Rate % — <span class="val" id="v-minWinRate">0</span></label><input type="range" id="minWinRate" min="0" max="100" step="5" value="0" /></div>
            <div class="field"><label title="Minimum pool liquidity in USD">Min Liquidity USD — <span class="val" id="v-minLiquidity">2000</span></label><input type="range" id="minLiquidity" min="0" max="100000" step="500" value="2000" /></div>
            <div class="field"><label title="Max % of supply held by the deployer">Max Dev % — <span class="val" id="v-maxDevHoldPct">15</span></label><input type="range" id="maxDevHoldPct" min="0" max="80" step="1" value="15" /></div>
            <div class="field"><label title="Max % held by top 10 wallets">Max Top-10 % — <span class="val" id="v-maxHolderConcentration">40</span></label><input type="range" id="maxHolderConcentration" min="0" max="90" step="1" value="40" /></div>
            <div class="field"><label title="Max % held by a single wallet">Max Top Holder % — <span class="val" id="v-maxTopHolderPct">40</span></label><input type="range" id="maxTopHolderPct" min="0" max="90" step="1" value="40" /></div>
            <div class="field"><label title="Composite rug/risk score ceiling (0-100)">Max Risk Score — <span class="val" id="v-maxRiskScore">70</span></label><input type="range" id="maxRiskScore" min="20" max="100" step="5" value="70" /></div>
            <div class="field"><label title="Estimated transfer tax / honeypot tax ceiling">Max Tax % — <span class="val" id="v-maxEstimatedTaxPct">25</span></label><input type="range" id="maxEstimatedTaxPct" min="5" max="80" step="5" value="25" /></div>
            <div class="field"><label title="Source wallet must have been active this many days">Min Activity Days — <span class="val" id="v-minActivityDays">7</span></label><input type="range" id="minActivityDays" min="1" max="30" step="1" value="7" /></div>
            <div class="field"><label title="Source wallet min trades in last 30 days">Min Trades 30d — <span class="val" id="v-minTradesLast30d">5</span></label><input type="range" id="minTradesLast30d" min="0" max="50" step="1" value="5" /></div>
            <div class="field"><label title="Minimum 24h volume USD (anti-rug)">Min Vol 24h USD — <span class="val" id="v-minVolume24hUsd">1000</span></label><input type="range" id="minVolume24hUsd" min="0" max="100000" step="500" value="1000" /></div>
            <div class="field"><label title="Minimum holder count (anti-rug)">Min Holders — <span class="val" id="v-minHolderCount">10</span></label><input type="range" id="minHolderCount" min="0" max="500" step="5" value="10" /></div>
          </div>
          <div class="mt-2 space-y-0">
            <div class="toggle-row"><span title="Master switch for rug / holder / LP safety checks">Anti-rug filters</span><label class="switch"><input type="checkbox" id="enableAntiRug" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Probe sellability and transfer tax before buying">Honeypot / tax probe</span><label class="switch"><input type="checkbox" id="checkHoneypot" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Skip if the deployer sold recently (dump risk)">Skip recent dev sells</span><label class="switch"><input type="checkbox" id="skipIfDevRecentSells" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Require liquidity pool to look locked / burned">Require LP locked</span><label class="switch"><input type="checkbox" id="requireLiquidityLocked" /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Require source wallets to meet activity / trade-count filters">Activity filter</span><label class="switch"><input type="checkbox" id="enableActivityFilter" checked /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Skip if mint authority is still active (can mint more)">Skip if mint authority</span><label class="switch"><input type="checkbox" id="skipIfMintAuthority" /><span class="slider"></span></label></div>
            <div class="toggle-row"><span title="Block tokens with high sniper/bundler/insider launch risk">Sniper / bundler filter</span><label class="switch"><input type="checkbox" id="enableSniperFilter" checked /><span class="slider"></span></label></div>
          </div>
          <div class="mt-2">
            <label class="ctl ctl-lg">
              <span>Sniper sensitivity <span class="tip" tabindex="0" data-tip="How strict the sniper/bundler thresholds are. High = more skips."></span></span>
              <select id="sniperSensitivity"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
            </label>
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveFilterConfig()" title="Save filter and anti-rug settings">Save Filters</button></div>
        </div>

        <div class="card">
          <div class="section-title">Selective Trading <span class="tip" tabindex="0" data-tip="High-conviction gating: score signals, limit trade frequency, scale size by risk."></span></div>
          <div class="toggle-row"><span title="Only take high-conviction setups">Selective mode</span><label class="switch"><input type="checkbox" id="sel-enabled" checked /><span class="slider"></span></label></div>
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

        <div class="card">
          <div class="section-title">Strategy <span class="tip" tabindex="0" data-tip="When and how aggressively to enter: convergence, migrations, early curve, auto-sell, re-buy."></span></div>
          <div class="toggle-row"><span title="Require N wallets before buying">Convergence</span><label class="switch"><input type="checkbox" id="enableConvergence" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Only trade migration/graduation events">Migration Only</span><label class="switch"><input type="checkbox" id="enableMigrationOnly" /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Boost size / priority when a migration is detected">Migration Priority</span><label class="switch"><input type="checkbox" id="enableMigrationPriority" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Prioritize tokens near bonding-curve completion">Near-migration curve priority</span><label class="switch"><input type="checkbox" id="enableBondingCurvePriority" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Prioritize early-curve buys when smart wallets pile in">Early-curve smart money priority</span><label class="switch"><input type="checkbox" id="enableEarlyCurvePriority" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Automatically sell on TP / SL / trailing rules">Auto-Sell</span><label class="switch"><input type="checkbox" id="enableAutoSell" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="After TP, watch for a dip + confirmation buys to re-enter">Re-Buy on Dip</span><label class="switch"><input type="checkbox" id="reBuyEnabled" checked /><span class="slider"></span></label></div>
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
          </div>
          <div class="mt-3"><button class="btn btn-primary" onclick="saveStrategyConfig()" title="Save strategy toggles and parameters">Save Strategy</button></div>
        </div>
      </div>

      <div class="grid md:grid-cols-2 gap-3 sm:gap-4">
        <div class="card">
          <div class="section-title">Risk Management <span class="tip" tabindex="0" data-tip="Position sizing, trailing stops, drawdown limits, and auto-pause when limits hit."></span></div>
          <div class="mb-3 p-3 rounded-lg" style="background:#0f172a;border:1px solid #334155">
            <div class="text-sm font-semibold text-slate-200 mb-2">Risk Level Preset</div>
            <div class="flex flex-wrap gap-2 items-center mb-2">
              <button type="button" class="btn bg-slate-800 text-slate-300 text-xs" id="cfg-risk-lvl-low" onclick="setRiskLevel('low')">Low</button>
              <button type="button" class="btn bg-slate-800 text-slate-300 text-xs" id="cfg-risk-lvl-medium" onclick="setRiskLevel('medium')">Medium</button>
              <button type="button" class="btn bg-slate-800 text-slate-300 text-xs" id="cfg-risk-lvl-high" onclick="setRiskLevel('high')">High</button>
            </div>
            <div id="cfg-risk-level-warning" class="hidden text-amber-300 text-sm mb-2 font-medium"></div>
            <div class="mint text-xs" id="cfg-risk-level-summary">Selecting a level applies recommended trade size, filters, stops, and selective gates.</div>
          </div>
          <div class="toggle-row"><span title="Enable the risk engine (limits, sizing, trails)">Risk engine</span><label class="switch"><input type="checkbox" id="riskEnabled" checked /><span class="slider"></span></label></div>
          <div class="toggle-row"><span title="Size buys from risk % of bankroll instead of fixed SOL">Risk-% sizing</span><label class="switch"><input type="checkbox" id="useRiskSizing" checked /><span class="slider"></span></label></div>
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
            <div class="toggle-row"><span title="Force-sell stuck positions with dead volume / no trades">Enable dead-volume exit</span><label class="switch"><input type="checkbox" id="enableDeadVolumeExit" checked /><span class="slider"></span></label></div>
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
          <div class="toggle-row"><span title="Enable MEV-aware send path">MEV protection</span><label class="switch"><input type="checkbox" id="enableMEVProtection" /><span class="slider"></span></label></div>
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
          <div class="mt-4 section-title">RPC Status <span class="tip" tabindex="0" data-tip="Latency and success rate for each configured RPC endpoint."></span></div>
          <div id="rpc-summary" class="mint mb-2">—</div>
          <div class="overflow-x-auto"><table id="rpc-table"><thead><tr><th>Endpoint</th><th>OK</th><th>Latency</th><th>Success</th><th>Active</th></tr></thead><tbody></tbody></table></div>
          <div class="mint mt-2" id="jito-status"></div>
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
    function showTab(name, btn) {
      document.querySelectorAll('[data-tab-panel]').forEach(el => {
        el.classList.toggle('hidden', el.getAttribute('data-tab-panel') !== name);
      });
      document.querySelectorAll('[data-tab]').forEach(el => {
        const on = el.getAttribute('data-tab') === name;
        el.classList.toggle('bg-emerald-600', on);
        el.classList.toggle('text-white', on);
        el.classList.toggle('bg-slate-800', !on);
        el.classList.toggle('text-slate-300', !on);
      });
      try { localStorage.setItem('botDashboardTab', name); } catch (_) {}
      if ((name === 'overview' || name === 'backtester') && window._chartsNeedResize) {
        window._chartsNeedResize = false;
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
      }
      if (name === 'backtester') {
        setTimeout(() => {
          if (window._lastBacktestCharts) updateBacktestCharts(window._lastBacktestCharts);
          window.dispatchEvent(new Event('resize'));
        }, 80);
      }
      if (name === 'logs') loadSystemLogs();
      if (name === 'overview' || name === 'signals') {
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
      'tradeAmountSol','riskMultiplier','convictionMultiplier','minProfitPercent','maxProfitPercent','stopLossPercent',
      'convergenceRequired','maxConcurrentPositions','dailyLossLimitSol','minWinRate','minLiquidity',
      'maxDevHoldPct','maxTopHolderPct','maxHolderConcentration','maxRiskScore','maxEstimatedTaxPct',
      'minActivityDays','minTradesLast30d','minVolume24hUsd','minHolderCount'
    ];
    rangeFields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => {
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
            ' · Curated: ' + data.sources.curated;
        }
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
      if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
      if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
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
      const overviewVisible = overview && !overview.classList.contains('hidden');
      const signalsVisible = signals && !signals.classList.contains('hidden');
      if (!overviewVisible && !signalsVisible) return;
      const now = Date.now();
      if (overviewVisible) {
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
              labels: ['low', 'medium', 'high'],
              datasets: [
                {
                  label: 'PnL (SOL)',
                  data: [0, 0, 0],
                  backgroundColor: 'rgba(52,211,153,0.7)',
                  yAxisID: 'y',
                },
                {
                  label: 'Win rate %',
                  data: [0, 0, 0],
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
          (cu.riskLevel ? ' · risk ' + String(cu.riskLevel).toUpperCase() : '');
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
          cfgUsedEl.innerHTML =
            'Config used: <strong style="color:#e2e8f0">' + String(cu.riskLevel).toUpperCase() +
            (cu.label ? ' (' + cu.label + ')' : '') + '</strong>' +
            ' · base ' + Number(cu.baseTradeAmountSol || 0) + ' SOL' +
            ' · SL ' + Number(cu.stopLossPercent || 0) + '%' +
            ' · max profit ' + Number(cu.maxProfitPercent || 0) + '%' +
            ' · risk/trade ' + Number(cu.riskPercentPerTrade || 0) + '%' +
            ' · max DD ' + Number(cu.maxDrawdownPct || 0) + '%' +
            ' · fee ' + Number(cu.feeBps || 0) + 'bps / slip ' + Number(cu.slippageBps || 0) + 'bps' +
            (cu.profitStrategyEnabled
              ? ' · profit tiers (partial@' + Number(cu.partialSellAt || 0) + '% / trail@' + Number(cu.trailingStopAfter || 0) + '%)'
              : ' · profit strategy off');
        } else {
          cfgUsedEl.classList.add('hidden');
          cfgUsedEl.textContent = '';
        }
      }
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
        wrSub.textContent =
          (sum.wins ?? 0) + 'W / ' + (sum.losses ?? 0) + 'L';
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
        wlCounts.textContent = (sum.wins ?? 0) + ' wins · ' + (sum.losses ?? 0) + ' losses';
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

      const tbody = document.querySelector('#bt-results-table tbody');
      const trades = data.trades || [];
      if (tbody) {
        tbody.innerHTML = trades.length === 0
          ? '<tr><td colspan="15" style="color:var(--muted)">No trades in this run</td></tr>'
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
              const reasonTip = (t.reasonDetail || reason).replace(/"/g, '&quot;') +
                (debugLines ? '\\n\\n— Debug —\\n' + debugLines.replace(/"/g, '&quot;') : '');
              return '<tr class="' + rowClass + '">' +
                '<td>' + fmtBacktestToken(t.symbol, t.name, t.mint) +
                (t.migrated ? ' 🚀' : t.isPumpFun ? ' 🎯' : '') +
                (t.isReBuy ? ' <span class="mint">rebuy</span>' : '') + '</td>' +
                '<td style="color:' + color + ';font-weight:700">' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%</td>' +
                '<td>' + fmtPnlSolUsd(t) + '</td>' +
                '<td>' + fmtExitTakes(t) + '</td>' +
                '<td class="mint" title="Smart wallet entry MC">' + fmtUsdShort(walletMc) + '</td>' +
                '<td class="mint" title="Your copy fill MC">' + fmtUsdShort(yourMc) + '</td>' +
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
                '<td class="mint">' + (t.smartWalletCount != null ? t.smartWalletCount : (t.sourceNames || []).length) +
                ((t.sourceNames || []).length ? ' (' + t.sourceNames.slice(0, 2).join(', ') + ')' : '') + '</td>' +
                '<td class="mint" title="' + reasonTip + '">' + reason.replace(/</g, '&lt;') +
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

    /** Token ticker with CA popover: Copy CA + Open Jupiter */
    function fmtTokenCa(symbol, name, mint) {
      const tick = (symbol || (mint ? String(mint).slice(0, 6) : '?')).trim();
      const label = escHtml(tick);
      const ca = String(mint || '').trim();
      if (!ca) return '<strong>' + label + '</strong>';
      const attr = escAttr(ca);
      const shown = escHtml(ca);
      const jup = escAttr(jupiterTokenUrl(ca));
      return '<span class="token-ca" tabindex="0" role="button" data-mint="' + attr +
        '" title="Click to copy CA · Open on Jupiter" onclick="copyContractAddress(event)">' +
        '<strong>' + label + '</strong>' +
        '<span class="ca-pop" onclick="event.stopPropagation()">' +
          '<div class="ca-label">Contract address</div>' +
          '<div class="ca-addr">' + shown + '</div>' +
          '<div class="ca-actions">' +
            '<button type="button" class="ca-btn" data-mint="' + attr + '" onclick="copyMintFromEl(event)">Copy CA</button>' +
            '<a class="ca-btn ca-jup" href="' + jup + '" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Open Jupiter</a>' +
          '</div>' +
          '<div class="ca-hint">Copy CA or view live on Jupiter</div>' +
        '</span>' +
      '</span>';
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
      if (ok && tokenHost) {
        tokenHost.classList.add('copied');
        const hint = tokenHost.querySelector('.ca-hint');
        if (hint) hint.textContent = 'Copied!';
        setTimeout(() => {
          tokenHost.classList.remove('copied');
          if (hint) hint.textContent = 'Copy CA or view live on Jupiter';
        }, 1400);
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
      if (ok && host) {
        host.classList.add('copied');
        const hint = host.querySelector('.ca-hint');
        if (hint) hint.textContent = 'Copied!';
        setTimeout(() => {
          host.classList.remove('copied');
          if (hint) hint.textContent = 'Copy CA or view live on Jupiter';
        }, 1400);
      }
      const st = document.getElementById('bt-status');
      if (st) st.textContent = (ok ? 'Copied CA: ' : 'Copy failed: ') + ca.slice(0, 8) + '…' + ca.slice(-4);
      if (!ok) alert('Could not copy: ' + ca);
    }

    async function runBacktest() {
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
        const data = await fetchJSON('/backtest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            hours: Number(document.getElementById('bt-hours').value),
            maxTrades: Number(document.getElementById('bt-max').value),
            simulations: Number((document.getElementById('bt-sims') || {}).value) || 1,
            startingBalanceSol: Number((document.getElementById('bt-start-bal') || {}).value) || undefined,
            strategyType: (document.getElementById('bt-strategy') || {}).value || 'auto',
            riskLevel: (document.getElementById('bt-risk-level') || {}).value || 'current',
            compareRiskLevels: !!(document.getElementById('bt-compare-risk') || {}).checked,
            useSavedConfigFilters: true,
            minLiquidityUsd: Number((document.getElementById('bt-min-liq') || {}).value) || 0,
            minMarketCapUsd: Number((document.getElementById('bt-min-mc') || {}).value) || 0,
            minVolumeUsd: Number((document.getElementById('bt-min-vol') || {}).value) || 0,
            maxRiskScore: Number((document.getElementById('bt-max-risk') || {}).value) || 0,
            useLiveData: document.getElementById('bt-live').checked,
            migrationsOnly: document.getElementById('bt-mig-only').checked,
            pumpFunOnly: (document.getElementById('bt-pump-only') || {}).checked,
            reBuyEnabled: (document.getElementById('bt-rebuy') || {}).checked,
            allowSynthetic: (document.getElementById('bt-synthetic') || { checked: true }).checked,
          }),
          timeoutMs: 180000,
        });
        setBtProgress(100, 'Complete');
        renderBacktestResult(data);
        showTab('backtester', document.querySelector('[data-tab=backtester]'));
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
      const [status, positions, logs, activity, cfg, walletsRaw, migrations, paper, sized] = await Promise.all([
        fetchJSON('/api/status'),
        fetchJSON('/api/positions'),
        fetchJSON('/api/logs?limit=50'),
        fetchJSON('/api/activity'),
        fetchJSON('/api/config'),
        fetchJSON('/wallets'),
        fetchJSON('/api/migrations'),
        fetchJSON('/paper-status'),
        fetchJSON('/api/signals').catch(() => ({ signals: [], trade: {} })),
      ]);
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

      const dot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      if (!status.monitor.running) {
        dot.className = 'dot dot-stopped'; statusText.textContent = 'Stopped';
      } else if (status.monitor.paused) {
        dot.className = 'dot dot-paused'; statusText.textContent = 'Paused';
      } else {
        dot.className = 'dot dot-running'; statusText.textContent = 'Running';
      }

      document.getElementById('btn-pause').textContent = status.monitor.paused ? 'Resume' : 'Pause';

      const badge = document.getElementById('mode-badge');
      badge.textContent = status.mode.toUpperCase();
      badge.className = 'badge ' + (status.mode === 'live' ? 'badge-live' : 'badge-paper');

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
      const _ob = document.getElementById('ov-balance-mirror');
      if (_ob) _ob.textContent = document.getElementById('balance').textContent;
      const _od = document.getElementById('ov-daily-mirror');
      if (_od) _od.textContent = document.getElementById('daily-pnl').textContent;

      // RPC status
      const rpc = status.rpc || {};
      const activeEp = (rpc.endpoints || []).find(e => e.isActive) || {};
      const rpcActiveEl = document.getElementById('rpc-active');
      if (rpcActiveEl) {
        rpcActiveEl.textContent = rpc.active || '—';
        rpcActiveEl.style.color = rpc.ok === false ? 'var(--red)' : '';
      }
      document.getElementById('rpc-latency').textContent =
        activeEp.latencyMs != null ? activeEp.latencyMs + 'ms' : '—';
      document.getElementById('rpc-summary').textContent =
        'Active: ' + (rpc.active || '—') +
        ' · Endpoints: ' + ((rpc.endpoints || []).length) +
        ' · Priority fee est: ' + (rpc.priorityFeeLamports != null ? rpc.priorityFeeLamports + ' lamports' : 'n/a');
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
          ? '<tr><td colspan="5" style="color:var(--muted)">No RPC endpoints configured</td></tr>'
          : rpc.endpoints.map(e => \`
            <tr>
              <td title="\${e.url}">\${e.label}</td>
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
      const pfEl = document.getElementById('stat-pf');
      const pf = s.profitFactor ?? 0;
      if (pfEl) {
        pfEl.textContent = pf >= 999 ? '∞' : pf.toFixed(2);
        pfEl.style.color = pf >= 1.5 ? 'var(--green)' : pf >= 1 ? 'var(--muted)' : 'var(--red)';
      }
      const pfHint = document.getElementById('stat-pf-hint');
      if (pfHint) pfHint.textContent = pf >= 1.5 ? 'Strong' : pf >= 1 ? 'Profitable' : pf > 0 ? 'Weak' : '—';
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
      pnlEl.textContent = (s.netPnlSol ?? 0).toFixed(4);
      pnlEl.style.color = (s.netPnlSol ?? 0) >= 0 ? 'var(--green)' : 'var(--red)';
      const retEl = document.getElementById('stat-return');
      retEl.textContent = (s.returnPct ?? 0).toFixed(1) + '%';
      retEl.style.color = (s.returnPct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)';
      document.getElementById('migrations').innerHTML =
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

      const migStatus = migrations.status || {};
      const migLive = document.getElementById('mig-live-status');
      if (migLive) {
        migLive.textContent =
          (migStatus.wsMode ? 'WS live' : 'poll fallback') +
          ' · ' + (migStatus.recentCount ?? 0) + ' tracked' +
          (migStatus.reconnectAttempts ? ' · reconnects:' + migStatus.reconnectAttempts : '') +
          (migStatus.priorityEnabled ? ' · priority ON' : ' · priority OFF');
      }
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
        document.getElementById('enableConvergence').checked = cfg.strategy.enableConvergence;
        document.getElementById('enableMigrationOnly').checked = cfg.strategy.enableMigrationOnly;
        document.getElementById('enableMigrationPriority').checked = !!cfg.strategy.enableMigrationPriority;
        const curvePri = document.getElementById('enableBondingCurvePriority');
        if (curvePri) curvePri.checked = cfg.strategy.enableBondingCurvePriority !== false;
        const earlyPri = document.getElementById('enableEarlyCurvePriority');
        if (earlyPri) earlyPri.checked = cfg.strategy.enableEarlyCurvePriority !== false;
        document.getElementById('enableAutoSell').checked = cfg.strategy.enableAutoSell !== false;
        document.getElementById('enableActivityFilter').checked = cfg.filters.enableActivityFilter !== false;
        const skipAuth = document.getElementById('skipIfMintAuthority');
        if (skipAuth) skipAuth.checked = !!cfg.filters.skipIfMintAuthority;
        const sniperEl = document.getElementById('enableSniperFilter');
        if (sniperEl) sniperEl.checked = cfg.filters.enableSniperFilter !== false;
        const sensEl = document.getElementById('sniperSensitivity');
        if (sensEl && cfg.filters.sniperSensitivity) {
          sensEl.value = cfg.filters.sniperSensitivity;
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
        document.getElementById('reBuyEnabled').checked = cfg.strategy.reBuyEnabled !== false;
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
        if (btBanner) {
          const rl = (cfg.riskLevel || 'medium').toUpperCase();
          const base = cfg.trade.baseTradeAmountSol ?? cfg.trade.tradeAmountSol;
          btBanner.textContent =
            'Saved: ' + rl + ' risk · base ' + base + ' SOL · SL ' +
            cfg.trade.stopLossPercent + '% · max profit ' + cfg.trade.maxProfitPercent +
            '% · filters inherited when fields are 0. Overrides below are optional.';
        }
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
        if (cfg.risk) {
          document.getElementById('riskEnabled').checked = cfg.risk.enabled !== false;
          document.getElementById('useRiskSizing').checked = cfg.risk.useRiskSizing !== false;
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
          if (document.getElementById('enableDeadVolumeExit')) {
            document.getElementById('enableDeadVolumeExit').checked = cfg.risk.enableDeadVolumeExit !== false;
          }
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
          const en = document.getElementById('ps-enabled');
          if (en) en.checked = ps.enabled !== false;
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
        if (cfg.selective) {
          const sel = cfg.selective;
          const setChk = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.checked = v !== false;
          };
          setChk('sel-enabled', sel.enabled);
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
          document.getElementById('enableMEVProtection').checked = !!cfg.mev.enableMEVProtection;
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
            <td>\${w.tradesLast7d != null ? w.tradesLast7d : '—'} / \${w.tradesLast30d != null ? w.tradesLast30d : '—'}\${cols > 7 ? ' / ' + (w.pumpFunTradeCount != null ? w.pumpFunTradeCount : '—') : ''}</td>
            <td>\${w.enabled === false ? '⏸ Disabled' : (w.isActive ? '✅ ' + (w.activityLabel || 'Active') : '⛔ ' + (w.activityLabel || 'Inactive'))}</td>
            \${cols >= 9 ? '<td class="mint">' + (w.watching ? '👁 Yes' : '—') + '</td>' : ''}
            <td>
              <button class="secondary" onclick="toggleWallet('\${w.address}', \${!w.enabled})">\${w.enabled ? 'Disable' : 'Enable'}</button>
              <button class="danger" onclick="removeWallet('\${w.address}')">Remove</button>
            </td>
          </tr>\`;
      wtbody.innerHTML = wallets.length === 0
        ? '<tr><td colspan="9" style="color:var(--muted)">No wallets — search above or add one below</td></tr>'
        : wallets.slice(0, 200).map(w => renderWalletRow(w, 9)).join('') +
          (wallets.length > 200
            ? '<tr><td colspan="9" class="mint">Showing 200 of ' + wallets.length + ' wallets</td></tr>'
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
      const ptbody = document.querySelector('#positions-table tbody');
      const posBadge = document.getElementById('open-positions-badge');
      const posOpenN = positions.open.length;
      if (posBadge) {
        posBadge.textContent = posOpenN + ' open';
        posBadge.setAttribute('data-empty', posOpenN === 0 ? '1' : '0');
      }
      ptbody.innerHTML = posOpenN === 0
        ? '<tr><td colspan="12"><div class="positions-empty"><strong>No open positions</strong><span>Live paper/live fills will appear here with PnL, trail, TP and SL.</span></div></td></tr>'
        : positions.open.map(p => {
          const pnl = p.pnlPct;
          const pnlCell = pnl == null
            ? '—'
            : '<span style="color:' + (pnl >= 0 ? 'var(--green)' : 'var(--red)') + '">' +
              (pnl >= 0 ? '+' : '') + pnl.toFixed(1) + '%</span>';
          let trailCell;
          if (p.trailingActive) {
            const stop = p.trailingStopPriceSol != null
              ? p.trailingStopPriceSol.toExponential(2)
              : '—';
            const peak = p.highWaterMarkSol != null
              ? p.highWaterMarkSol.toExponential(2)
              : '—';
            trailCell =
              '<span style="color:var(--green)">ACTIVE ' + (p.trailingStopPct ?? '—') + '%</span>' +
              '<div class="mint">stop ' + stop + ' · peak ' + peak + '</div>';
          } else {
            trailCell =
              '<span class="mint">off until +' + trailArmAt + '%</span>' +
              '<div class="mint">then ' + (p.trailingStopPct ?? '—') + '% from peak</div>';
          }
          const mode = p.tradeMode === 'live' ? ' <span class="mint">[live]</span>' : '';
          const ar = p.antiRug;
          const be = ar?.birdeye;
          const riskBit = ar
            ? '<div class="mint" style="color:' +
              (ar.riskLevel === 'high' || ar.riskLevel === 'critical' ? 'var(--red)' : 'var(--muted)') +
              '">risk ' + ar.riskScore + (ar.flags && ar.flags[0] ? ' · ' + ar.flags[0] : '') + '</div>' +
              (be && (be.liquidityUsd != null || be.volume24hUsd != null)
                ? '<div class="mint">BE liq $' +
                  (be.liquidityUsd != null ? Number(be.liquidityUsd).toFixed(0) : '?') +
                  (be.volume24hUsd != null ? ' · vol $' + Number(be.volume24hUsd).toFixed(0) : '') +
                  (be.smartMoneyScore != null ? ' · SM ' + be.smartMoneyScore : '') +
                  '</div>'
                : '')
            : '';
          const buyMc = fmtUsdShort(p.entryMarketCapUsd);
          const sellLabel = (p.symbol || p.mint.slice(0, 6)).replace(/'/g, "\\\\'");
          const costCell = fmtCostSolUsd(p.costSol, p.costUsd, p.solUsd);
          const volCell = fmtVolH1(p.volumeH1Usd, p.txnsH1);
          const openedCell = fmtOpenedHoldCell(p.openedAt);
          return \`
          <tr>
            <td>\${fmtToken(p.symbol, p.name, p.mint)}\${mode}\${riskBit}</td>
            <td>\${fmtTokenName(p.symbol, p.name, p.mint)}</td>
            <td>\${fmtMintCa(p.mint)}</td>
            <td class="mint" title="Market cap at buy">\${buyMc}</td>
            <td class="pos-cost-cell" title="Position cost">\${costCell}</td>
            <td>\${volCell}</td>
            <td>\${pnlCell}</td>
            <td>\${trailCell}</td>
            <td>+\${p.takeProfitPct.toFixed(0)}%</td>
            <td>\${p.stopLossPct}%</td>
            <td>\${openedCell}</td>
            <td><button class="danger" onclick="forceSellPosition('\${p.id}', '\${sellLabel}')" title="Force sell entire position">Sell</button></td>
          </tr>\`;
        }).join('');
      ensurePosHoldTicker();
      tickOpenPositionHolds();

      const ctbody = document.querySelector('#closed-table tbody');
      const closed = (positions.closed || []).slice().reverse().slice(0, 25);
      ctbody.innerHTML = closed.length === 0
        ? '<tr><td colspan="7" style="color:var(--muted)">No closed trades yet</td></tr>'
        : closed.map(p => \`
          <tr>
            <td>\${fmtToken(p.symbol, p.name, p.mint)}</td>
            <td>\${fmtTokenName(p.symbol, p.name, p.mint)}</td>
            <td class="mint" title="Market cap at buy">\${fmtUsdShort(p.entryMarketCapUsd)}</td>
            <td class="mint" title="Market cap at exit">\${fmtUsdShort(p.exitMarketCapUsd)}</td>
            <td style="color:\${(p.pnlSol||0)>=0?'var(--green)':'var(--red)'}">
              \${(p.pnlSol||0)>=0?'+':''}\${(p.pnlSol||0).toFixed(4)} SOL
              <span class="mint">(\${(p.pnlPct||0).toFixed(0)}%)</span>
            </td>
            <td class="mint">\${p.reason || '—'}</td>
            <td>\${p.closedAt ? fmtTimeAgoCell(p.closedAt) : '—'}</td>
          </tr>\`).join('');

      const rb = positions.rebuy || {};
      const rbStatus = rb.status || status.monitor?.rebuy || {};
      const rbEl = document.getElementById('rebuy-status');
      if (rbEl) {
        rbEl.textContent =
          (rbStatus.enabled ? 'ON' : 'OFF') +
          ' · watching ' + (rbStatus.watching ?? 0) +
          ' · dip-armed ' + (rbStatus.dipArmed ?? 0) +
          ' · sells tracked ' + (rbStatus.sellHistoryCount ?? (positions.sellHistory || []).length);
      }
      const rtbody = document.querySelector('#rebuy-table tbody');
      const candidates = rb.candidates || [];
      if (rtbody) {
        rtbody.innerHTML = candidates.length === 0
          ? '<tr><td colspan="6" style="color:var(--muted)">No re-buy watches — profitable TP sells start monitoring</td></tr>'
          : candidates.slice(0, 15).map(c => \`
            <tr>
              <td>\${fmtToken(c.symbol, c.name, c.mint)}</td>
              <td>\${c.status}</td>
              <td>\${c.dipPctFromPeak != null ? c.dipPctFromPeak.toFixed(1) + '%' : '—'}</td>
              <td>\${(c.confirmationWallets || []).length}\${c.confirmationWalletNames?.length ? ' (' + c.confirmationWalletNames.slice(0,3).join(', ') + ')' : ''}</td>
              <td>\${c.volumeChangePct != null ? ((c.volumeChangePct>=0?'+':'') + c.volumeChangePct.toFixed(0) + '%') : '—'}</td>
              <td class="mint">\${c.lastReason || '—'}</td>
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
            const curveBadge = bc.progressPct != null
              ? \` <span style="color:\${bc.nearMigration ? 'var(--green)' : 'var(--muted)'};font-weight:600">curve \${Number(bc.progressPct).toFixed(0)}%\${bc.nearMigration ? ' · near-mig' : ''}\${bc.solRaised != null ? ' · ' + Number(bc.solRaised).toFixed(1) + ' SOL' : ''}</span>\`
              : '';
            const sniperBadge = (sn.sniperScore != null || sn.sniperCount != null)
              ? \` <span style="color:\${sn.highRisk || sn.sniperHighRisk ? 'var(--red)' : 'var(--muted)'}">sniper \${sn.sniperScore != null ? sn.sniperScore : '?'}\${sn.sniperCount != null ? ' · n=' + sn.sniperCount : ''}\${sn.bundlerPct != null ? ' · bundler ' + Number(sn.bundlerPct).toFixed(0) + '%' : ''}\${sn.insiderPct != null ? ' · insider ' + Number(sn.insiderPct).toFixed(0) + '%' : ''}</span>\`
              : '';
            const be = a.birdeye || ar.birdeye || {};
            const beLiq = be.liquidityUsd != null ? Number(be.liquidityUsd) : (m.liquidityUsd != null ? Number(m.liquidityUsd) : null);
            const beVol = be.volume24hUsd != null ? Number(be.volume24hUsd) : null;
            const beHold = be.holder != null ? Number(be.holder) : null;
            const beSm = be.smartMoneyScore != null ? Number(be.smartMoneyScore) : null;
            const birdeyeBadge = (beLiq != null || beVol != null || beSm != null)
              ? \` <span style="color:var(--muted)">BE liq $\${beLiq != null ? beLiq.toFixed(0) : '?'}\${beVol != null ? ' · vol24h $' + beVol.toFixed(0) : ''}\${beHold != null ? ' · holders ' + beHold : ''}\${beSm != null ? ' · SM ' + beSm : ''}\${be.source && be.source !== 'none' ? ' · ' + be.source : ''}</span>\`
              : '';
            const metricsLine = (m.liquidityUsd != null || m.devHoldPct != null || ar.riskScore != null || bc.progressPct != null || sn.sniperScore != null || beLiq != null || beVol != null)
              ? \` <span class="mint">liq $\${m.liquidityUsd != null ? Number(m.liquidityUsd).toFixed(0) : (beLiq != null ? beLiq.toFixed(0) : '?')} · dev \${m.devHoldPct != null ? Number(m.devHoldPct).toFixed(1) + '%' : '?'} · top10 \${m.top10HoldPct != null ? Number(m.top10HoldPct).toFixed(0) + '%' : (m.topHolderPct != null ? Number(m.topHolderPct).toFixed(1) + '%' : '?')}\${m.devActiveRecently ? ' · dev active' : ''}\${ar.honeypot ? ' · honeypot?' : ''}\${ar.recentDevSells ? ' · dev sells' : ''}\${ar.liquidityLockedOrBurned === true ? ' · LP locked' : ''}\${flagBits ? ' · ' + flagBits : ''}</span>\${birdeyeBadge}\${curveBadge}\${sniperBadge}\${riskBadge}\`
              : '';
            return \`
          <div class="log-entry">
            <strong>\${a.walletName}</strong> bought
            \${fmtToken(a.symbol, a.name, a.mint)}
            \${a.name && a.name !== a.symbol ? '<span class="mint">(' + escHtml(a.name) + ')</span>' : ''}
            \${a.isMigration ? '🚀' : a.earlyBuy ? '🌱' : a.isPumpFun ? '🎯' : ''}
            \${a.earlyBuy && a.earlyBuyerCount ? '<span class="mint">early×' + a.earlyBuyerCount + '</span>' : ''}
            \${metricsLine}
            <span class="mint">\${a.mint ? fmtMintCa(a.mint) : ''} · \${fmtTimeAgoCell(a.timestamp)}</span>
          </div>\`;
          }).join('');

      const actEl = document.getElementById('activity');
      if (actEl) actEl.innerHTML = activityHtml;
      const actSig = document.getElementById('activity-signals');
      if (actSig) actSig.innerHTML = activityHtml;

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
      try {
        await fetchJSON('/api/config/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) });
        refresh();
        loadTradingWallets();
      } catch (err) {
        alert(err.message);
      }
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

    async function saveTradeConfig() {
      const body = {};
      ['tradeAmountSol','riskMultiplier','convictionMultiplier','minProfitPercent','maxProfitPercent','stopLossPercent'].forEach(k => {
        body[k] = Number(document.getElementById(k).value);
      });
      body.baseTradeAmountSol = body.tradeAmountSol;
      await fetchJSON('/api/config/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      alert('Trade settings saved');
    }

    async function saveFilterConfig() {
      const body = {
        enableActivityFilter: document.getElementById('enableActivityFilter').checked,
        skipIfMintAuthority: document.getElementById('skipIfMintAuthority').checked,
        enableAntiRug: document.getElementById('enableAntiRug').checked,
        checkHoneypot: document.getElementById('checkHoneypot').checked,
        skipIfDevRecentSells: document.getElementById('skipIfDevRecentSells').checked,
        requireLiquidityLocked: document.getElementById('requireLiquidityLocked').checked,
        enableSniperFilter: document.getElementById('enableSniperFilter').checked,
        sniperSensitivity: document.getElementById('sniperSensitivity').value,
      };
      ['convergenceRequired','maxConcurrentPositions','dailyLossLimitSol','minWinRate','minLiquidity',
       'maxDevHoldPct','maxTopHolderPct','maxHolderConcentration','maxRiskScore','maxEstimatedTaxPct',
       'minActivityDays','minTradesLast30d','minVolume24hUsd','minHolderCount'].forEach(k => {
        const el = document.getElementById(k);
        if (el) body[k] = Number(el.value);
      });
      body.maxDevPercent = body.maxDevHoldPct;
      await fetchJSON('/api/config/filters', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      alert('Filters saved');
    }

    async function saveSelectiveConfig() {
      await fetchJSON('/api/config/selective', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('sel-enabled').checked,
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
      alert('Selective trading settings saved');
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

    async function saveStrategyConfig() {
      await fetchJSON('/api/config/strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enableConvergence: document.getElementById('enableConvergence').checked,
          enableMigrationOnly: document.getElementById('enableMigrationOnly').checked,
          enableMigrationPriority: document.getElementById('enableMigrationPriority').checked,
          enableBondingCurvePriority: document.getElementById('enableBondingCurvePriority').checked,
          nearMigrationCurvePct: Number(document.getElementById('nearMigrationCurvePct').value),
          enableEarlyCurvePriority: document.getElementById('enableEarlyCurvePriority').checked,
          earlyCurveMaxPct: Number(document.getElementById('earlyCurveMaxPct').value),
          minEarlyBirdeyeSmartMoneyScore: Number(document.getElementById('minEarlyBirdeyeSmartMoneyScore').value),
          earlyCurveMinSmartWallets: Number(document.getElementById('earlyCurveMinSmartWallets').value),
          enableAutoSell: document.getElementById('enableAutoSell').checked,
          migrationSizeMultiplier: Number(document.getElementById('migrationSizeMultiplier').value),
          migrationSlippageBps: Number(document.getElementById('migrationSlippageBps').value),
          reBuyEnabled: document.getElementById('reBuyEnabled').checked,
          reBuyMinProfitPct: Number(document.getElementById('reBuyMinProfitPct').value),
          reBuyDipPercent: Number(document.getElementById('reBuyDipPercent').value),
          confirmationThreshold: Number(document.getElementById('confirmationThreshold').value),
          reBuyVolumeIncreasePct: Number(document.getElementById('reBuyVolumeIncreasePct').value),
        }),
      });
      alert('Strategy saved');
    }

    async function saveRiskConfig() {
      await fetchJSON('/api/risk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: document.getElementById('riskEnabled').checked,
          useRiskSizing: document.getElementById('useRiskSizing').checked,
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
          enableDeadVolumeExit: document.getElementById('enableDeadVolumeExit').checked,
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
      alert('Risk settings saved');
      refresh();
    }

    function updateRiskLevelUI(cfg) {
      const level = (cfg && cfg.riskLevel) || 'medium';
      const sum = (cfg && cfg.riskLevelSummary) || {};
      const active = sum.active || {};
      const ids = ['low', 'medium', 'high'];
      ids.forEach((id) => {
        ['risk-lvl-', 'cfg-risk-lvl-'].forEach((prefix) => {
          const btn = document.getElementById(prefix + id);
          if (!btn) return;
          const on = id === level;
          btn.className = on
            ? 'btn btn-primary text-xs sm:text-sm'
            : 'btn bg-slate-800 text-slate-300 text-xs sm:text-sm';
        });
      });
      const label = document.getElementById('risk-level-label');
      if (label) label.textContent = (sum.label || level).toUpperCase() + (sum.description ? ' — ' + sum.description : '');

      const warnText =
        level === 'high'
          ? (sum.warning || '⚠️ High risk mode increases position size and reduces filters — use with caution')
          : '';
      ['risk-level-warning', 'cfg-risk-level-warning'].forEach((wid) => {
        const w = document.getElementById(wid);
        if (!w) return;
        if (warnText) {
          w.textContent = warnText;
          w.classList.remove('hidden');
        } else {
          w.textContent = '';
          w.classList.add('hidden');
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

      const btBanner = document.getElementById('bt-config-banner');
      if (btBanner && cfg && cfg.trade) {
        const base = cfg.trade.baseTradeAmountSol ?? cfg.trade.tradeAmountSol;
        btBanner.textContent =
          'Saved: ' + String(level).toUpperCase() + ' risk · base ' + base +
          ' SOL · SL ' + cfg.trade.stopLossPercent + '% · max profit ' +
          cfg.trade.maxProfitPercent +
          '% · filters inherited when fields are 0. Overrides below are optional.';
      }
    }

    async function setRiskLevel(level) {
      if (level === 'high') {
        const ok = confirm(
          '⚠️ High risk mode increases position size and reduces filters — use with caution.\\n\\nApply High risk recommended settings?'
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
          window._cfgLoaded = false;
          updateRiskLevelUI(data.config);
        }
        alert(
          'Risk level set to ' + String(level).toUpperCase() +
          (data.warning ? '\\n' + data.warning : '') +
          '\\nRecommended settings applied.'
        );
        refresh();
      } catch (err) {
        alert(err.message || String(err));
      }
    }

    async function saveProfitStrategy() {
      const status = document.getElementById('ps-status');
      try {
        const data = await fetchJSON('/api/profit-strategy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: document.getElementById('ps-enabled').checked,
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
        refresh();
      } catch (err) {
        if (status) status.textContent = err.message || String(err);
      }
    }

    async function saveMevConfig() {
      await fetchJSON('/api/mev', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enableMEVProtection: document.getElementById('enableMEVProtection').checked,
          useJitoBundles: document.getElementById('useJitoBundles').checked,
          sandwichProtection: document.getElementById('sandwichProtection').checked,
          abortOnSandwichRisk: document.getElementById('abortOnSandwichRisk').checked,
          tipMultiplier: Number(document.getElementById('tipMultiplier').value),
          priorityFeeMultiplier: Number(document.getElementById('priorityFeeMultiplier').value),
          sandwichMaxRecentBuys: Number(document.getElementById('sandwichMaxRecentBuys').value),
          tipLamports: Number(document.getElementById('jitoTipLamports').value),
          jitoEnabled: document.getElementById('useJitoBundles').checked &&
            document.getElementById('enableMEVProtection').checked,
        }),
      });
      alert('MEV settings saved');
      refresh();
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

    loadTradingWallets();
    refreshDiscoveryStatus();
    refresh();
    setInterval(refresh, 5000);
    const savedTab = (() => { try { return localStorage.getItem('botDashboardTab'); } catch (_) { return null; } })();
    showTab(savedTab || 'overview');
  </script>

</body>
</html>`;
