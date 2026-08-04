/**
 * Structured Bot Info "What's New" changelog.
 *
 * Add a new entry at the top when you ship a user-visible feature/fix.
 * Tag `sections` with Bot Info chip ids so unread counters can light up.
 * check:botinfo fails if package.json version is missing from this catalog.
 */

export const BOT_INFO_SECTION_IDS = [
  'overview',
  'modes',
  'risk',
  'microbots',
  'learning',
  'scanners',
  'execution',
  'zion',
  'copy',
  'backtester',
  'alerts',
  'backup',
  'knobs',
] as const;

export type BotInfoSectionId = (typeof BOT_INFO_SECTION_IDS)[number];

export interface BotInfoChangelogEntry {
  /** Semver without leading v, e.g. "1.2.57" */
  version: string;
  /** Short operator-facing title */
  title: string;
  /** Bot Info chips that receive update counts for these items */
  sections: readonly BotInfoSectionId[];
  /** One-line bullets; each bullet counts as one "item" for section badges */
  items: readonly string[];
}

/**
 * Newest first. Keep ~10–14 recent patches; older history can be trimmed.
 */
export const BOT_INFO_CHANGELOG: readonly BotInfoChangelogEntry[] = [
  {
    version: '1.2.144',
    title: 'Copy vs Scan Module Badges',
    sections: ['knobs', 'overview'],
    items: [
      'Settings → Modules now show Copy / Scan badges so you can tell which strategies gate tracked-wallet copy vs Market Scanner / TA signals.',
      'Shared entry filters show both badges; exits and sizing stay unmarked (apply to any open trade).',
    ],
  },
  {
    version: '1.2.143',
    title: 'Overview Stats Time Window',
    sections: ['overview'],
    items: [
      'Overview Win Rate / Max DD / Trades / Status PF now filter by 1h, 24h, 7d, 30d, or All — same pill UI as Micro Bot Performance.',
      'Wallets, Signals, Trade Rate, and Entries stay live (not windowed).',
    ],
  },
  {
    version: '1.2.142',
    title: 'Restore Opens — Daily Loss Stay Off',
    sections: ['risk', 'microbots', 'overview'],
    items: [
      'Auto-pause OFF now forces Daily Loss SOL to 0 on boot and Filters save — stops backup/bake from re-arming 0.5 and silently blocking all buys while day PnL is negative.',
      'Migration Sniper max MC re-floored to $175k (v2) when overrides regress; live daily loss cleared so entries can open again.',
    ],
  },
  {
    version: '1.2.141',
    title: 'Zion KOL Scanner RPC Cooldown Fix',
    sections: ['zion', 'scanners'],
    items: [
      'KOL feed empty state no longer says “enable Zion” when Zion is ON — it shows RPC 429 cooldown / last error instead.',
      'Zion KOL polls use smaller batches, staggered RPC calls, and longer cool-downs after Alchemy CU/s 429s so lastPollAt can advance again.',
    ],
  },
  {
    version: '1.2.140',
    title: 'More Scanner Fills — Widen Mig MC + Softer H1 Vol',
    sections: ['scanners', 'microbots', 'overview'],
    items: [
      'Migration Sniper max MC raised to $175k when still stuck on the old ~$55k override that rejected most mid-MC names.',
      'Market Scanner min 1h volume default 5000 → 2500; scanner ON uses the global toggle so profile gates cannot false-OFF all scanner buys.',
      'Stale tuning skip counters can be cleared; daily loss remains Off and is not the live blocker.',
    ],
  },
  {
    version: '1.2.139',
    title: 'Auto-pause OFF Clears Daily Loss Gate',
    sections: ['risk', 'overview'],
    items: [
      'Turning Auto-pause OFF now also sets Daily Loss SOL to 0 (Off) — previously Auto-pause OFF still left Filters daily at 0.5 and fight-log showed “daily loss limit”.',
      'Live Daily Loss was set to Off so entries are no longer blocked while day PnL is negative.',
    ],
  },
  {
    version: '1.2.138',
    title: 'Daily Loss Off + Lifetime Counters',
    sections: ['risk', 'overview', 'microbots'],
    items: [
      'Daily Loss SOL can be set to 0 (Off) — no buy block and no daily auto-pause; Risk card now shows Daily Loss next to Weekly.',
      'Turning Auto-pause OFF clears sticky halt; Clear halt adds a short same-reason re-arm grace so trading can resume.',
      'Overview Win Rate / Trades use lifetime closed counts (monotonic) — no longer shrink when the 200-row closed list rotates; subtitle is wins W / losses L.',
      'Micro-bot progress shows durable learning episodes plus session closed for that profile (Scalper episodes can exceed Overview trades by design).',
    ],
  },
  {
    version: '1.2.137',
    title: 'RPC Debug Cleanup',
    sections: ['execution'],
    items: [
      'Removed temporary RPC debug instrumentation after verifying adaptive skip heal and scanner load fixes (1.2.133–1.2.136).',
    ],
  },
  {
    version: '1.2.136',
    title: 'Adaptive Skip Heal',
    sections: ['execution', 'scanners'],
    items: [
      'Gate skip samples are rate-limited (per lane) so bonding-curve micro-skips cannot pin scanner×3 forever.',
      'When Secondary is idle (0 in-flight / empty queue), adaptive heals instead of staying locked at ×3 from an aging 60s window.',
    ],
  },
  {
    version: '1.2.135',
    title: 'Market Scanner Load Backoff',
    sections: ['scanners', 'execution'],
    items: [
      'Adaptive scanner×3 now actually skips Market/Alpha/Zion ticks (previously only Critical shed did).',
      'Market Scanner respects adaptive poll interval; enrich + grad-watch budgets cut (16 @ concurrency 2) so Secondary RPS is not blown.',
    ],
  },
  {
    version: '1.2.134',
    title: 'AlphaScan Dashboard RPC Throttle',
    sections: ['scanners', 'execution'],
    items: [
      'Dashboard /api/alphascan no longer re-runs bonding-curve enrich every ~5s — respects the AlphaScan poll interval and serves cache when fresh.',
      'Background AlphaScan feed pass still force-refreshes on its own schedule.',
    ],
  },
  {
    version: '1.2.133',
    title: 'RPC Skip Loop + AlphaScan Burst Fix',
    sections: ['execution', 'scanners'],
    items: [
      'Adaptive scanner× no longer locks forever on lifetime Secondary skip counts — only a rolling 60s window drives backoff.',
      'AlphaScan curve enrich capped (16) with concurrency 2 instead of Promise.all(40), so Alchemy Secondary RPS is not blown at boot.',
      'RPC Status warning uses recent skips/60s, not the lifetime gate counter.',
    ],
  },
  {
    version: '1.2.132',
    title: 'Fair Soft-Watch + Safer Scanners',
    sections: ['execution', 'copy', 'scanners'],
    items: [
      'Soft-watch rotates fairly across the full Favourites pool (least-recently-covered first) with a smaller sticky-hot slice; coverage % logged + shown in RPC Status.',
      'Safer scanner floors: Market ~22s, AlphaScan ~55s, Zion ~75–90s — still on Secondary, still adaptive.',
      'Utility prefers rpc-url / strong non-public routes; weak public failover stays sticky (less thrash) and keeps Favourites slowed.',
      'Fix: Market Scanner no longer permanently self-defers after a few Secondary gate skips; “buy in progress” uses a 15s cooldown instead of 45m.',
    ],
  },
  {
    version: '1.2.131',
    title: 'RPC Adaptive Stabilisation',
    sections: ['execution', 'scanners', 'copy', 'knobs'],
    items: [
      'Adaptive backoff: high Secondary skips / Helius latency / weak Utility auto-slow scanners and Favourites; Critical stays protected.',
      'Dead endpoints (e.g. QuickNode) enter escalating quarantine — no probe storms; Utility prefers stronger publics and cuts load on publicnode failover.',
      'RPC Status shows quarantine + adaptive scanner/utility multipliers and clear [rpc-load]/[rpc-quarantine] logs.',
      'Settings → Trade Caps: raise Max trades/hour (and cooldown) so Lane Fight “trade cap N/M per hour” stops blocking when you want more opens.',
    ],
  },
  {
    version: '1.2.130',
    title: 'Background RPC Pressure Cut',
    sections: ['execution', 'copy', 'scanners'],
    items: [
      'Hard per-cycle wallet poll caps + stagger; Favourites/activity yield when Critical is busy.',
      'Activity refresh skips fresh wallets and rotates ≤8 per tick; Market/Alpha/Zion skip ticks under load protection with clear [rpc-load] logs.',
    ],
  },
  {
    version: '1.2.129',
    title: 'RPC Load Stabilisation',
    sections: ['execution', 'copy', 'knobs'],
    items: [
      'Per-lane concurrency + rate limits (Critical / Scanners / Utility) with queue/skip so background polls cannot pile up a few minutes after boot.',
      'Slower Favourites soft-watch + activity refresh; health probes less aggressive; dead endpoints (e.g. QuickNode) get a hard-fail cooldown; withRpc retries capped with backoff.',
      'RPC Status shows Lane gate in-flight/queue/skip so overload vs provider issues are visible; Soft watch cap 0 still pauses Favourites watch.',
    ],
  },
  {
    version: '1.2.128',
    title: 'Peak Profit Protection',
    sections: ['microbots', 'learning', 'execution'],
    items: [
      'Soft Peak Profit Protection arms at a share of target TP (default 50%; scalpers 40%) and full-exits on proportional giveback from peak (default 33%/30%) — additive only; never overwrites hard TP/SL, trail, or dead-market.',
      'Micro Bots card toggle + scalper vs non-scalper knobs; per-profile Arm % of TP / Giveback % of peak; open trades show Peak Protect when armed; Self-Learn may nudge those two knobs only (±3–5%) with rollback.',
    ],
  },
  {
    version: '1.2.127',
    title: 'MARL Lagging Profile Support',
    sections: ['microbots', 'learning'],
    items: [
      'MARL can soft-boost quiet or under-utilised micro-bot profiles in lane ranking and prefer size-down over hard skip on low-MC pile-ins — never forces past filters, ML, TP, or SL.',
      'Micro Bots MARL card adds a Lagging profile support checkbox, lagging/supported/cooling badges, and a short status list; toggle defaults on when MARL is enabled.',
    ],
  },
  {
    version: '1.2.126',
    title: 'Zion Clear chat with archive',
    sections: ['zion'],
    items: [
      'Zion tab and floating chat have a Clear button — the live thread is archived under DATA_DIR/zion-chat-archives.json (up to 40 clears), then emptied. Improvement Requests stay.',
    ],
  },
  {
    version: '1.2.125',
    title: 'Pin Node 22 for Render deploys',
    sections: ['backup'],
    items: [
      'package.json engines now pin Node 22.x so Render no longer tries (and fails) to install Node 26 from a >=20 range.',
    ],
  },
  {
    version: '1.2.124',
    title: 'Fix Full-trade Exit MC vs partials mismatch',
    sections: ['overview', 'execution'],
    items: [
      'Closed Trades “Full trade” Exit MC is now size-weighted across partials + final (and stored that way on new closes), so it tracks total PnL instead of only the last bag’s fade print.',
    ],
  },
  {
    version: '1.2.123',
    title: 'Zion chat: no mobile focus zoom',
    sections: ['zion'],
    items: [
      'Zion chat inputs (tab + floating popup) use 16px text so iOS Safari no longer auto-zooms when you tap to type.',
    ],
  },
  {
    version: '1.2.122',
    title: 'Zion proactive performance analyst',
    sections: ['zion', 'learning'],
    items: [
      'Zion now reads micro-bot performance, learning health, timing quality, ML modes, MARL, and skip reasons, then answers in Observe → Explain → Strengths/Weak spots → Next actions.',
      'Suggestions stay advisory for ML/profile knobs; with Semi-Autonomous ON, only allowlisted global gates can become reviewable Change Requests — never auto-applied, never ML/TP/SL writes.',
    ],
  },
  {
    version: '1.2.121',
    title: 'Learning Progress & System Diagnostics',
    sections: ['learning', 'overview'],
    items: [
      'Bot Performance adds a Learning Progress & System Diagnostics panel: System Health Score, plain-English setup/warnings, and per-bot learning cards with progress, status, trend, and what each bot has learned.',
      'Read-only snapshot (GET /api/learning-diagnostics) — no learning settings change. Zion can answer questions about learning progress and system health from the same data.',
    ],
  },
  {
    version: '1.2.120',
    title: 'Auto-promote Self-Learn ML mode',
    sections: ['learning'],
    items: [
      'Each micro-bot ML field now auto-advances shadow → hybrid → lead from episode count, holdout quality, and Level (end state is lead when healthy).',
      'Soft demote lead → hybrid if the model goes stale or holdout collapses; operator can still set off/manual. MARL and Mode (shadow/auto apply) are unchanged.',
    ],
  },
  {
    version: '1.2.119',
    title: 'Learning feedback enrichment (timing quality)',
    sections: ['learning'],
    items: [
      'Closed trades now store entry/exit quality scores and a timingReward from MFE/MAE/giveback — feedback enrichment only; no live TP/SL or gate resets.',
      'Self-Learn can propose tiny timing deltas (±3–5%) on trail tighten, momentum fade, and trail arm; soft exit feedback weights ranking only.',
    ],
  },
  {
    version: '1.2.118',
    title: 'Zion chat sync across tab and popup',
    sections: ['zion'],
    items: [
      'Zion Agent tab chat and floating popup now share one in-memory thread and always paint together after send, refresh, or typewriter.',
      'Returning to the Zion tab (or opening the popup) instantly syncs from cache then force-refreshes chat history from the server (no-store).',
    ],
  },
  {
    version: '1.2.117',
    title: 'Migration Sniper event lane (hold → spike exit)',
    sections: ['microbots', 'scanners'],
    items: [
      'Migration Sniper retuned as an event lane: no TA affinity; watch ~80% → arm → enter from ~90% when armed; hold through migration; exit on first spike + volume (reason MIG_FIRST_SPIKE).',
      'Replaces the old 8–45s post_migration_scalp micro-timer with wider SL (~15%), post-mig max hold ~4m, and total safety ~8–12m; conservative size 0.7× / 0.15 SOL cap; default ON via migSniperEventLane_v1.',
      'MS funnel strip on Graduation watchlist: watch / armed / triggered / fire≠arm / handoff fail / expired / invalid tallies for diagnosis.',
      'Relaxed MS conviction/wallet floors and soft buy-pressure on grad-watch; chart/pattern modules off for this profile.',
    ],
  },
  {
    version: '1.2.116',
    title: 'MARL placement, Zion chat persist, Isaac voice',
    sections: ['microbots', 'zion'],
    items: [
      'Micro Bots: Multi-Agent RL card now sits directly under Automatic Profile Scoring (same Enable MARL / collapsed-by-default row).',
      'Zion chat: messages persist across hard refresh and tab switches (server DATA_DIR/zion-agent.json + localStorage mirror); popup and Zion tab share one thread with time/date stamps.',
      'Zion chat history capped at 80 messages on disk (UI loads the latest 40) so the thread stays bounded.',
      'Zion voice: always addresses Isaac; short 1–2 sentence replies for hi/bye/thanks/smalltalk; rotating warm/witty/chill/coachy/tech vibes; tighter technical answers.',
    ],
  },
  {
    version: '1.2.115',
    title: 'Zion typing polish + Valton signature',
    sections: ['zion'],
    items: [
      '“Zion is typing…” now holds for about 2 seconds before the reply starts.',
      'Assistant replies type out quickly (about 1–2s, up to ~4s for long answers) instead of appearing all at once.',
      'Reply footer is now “~ Zion Valton” (provider/model attribution removed from the chat bubble).',
    ],
  },
  {
    version: '1.2.114',
    title: 'Zion launcher peach theme',
    sections: ['zion'],
    items: [
      'Floating Zion chat launcher now uses the solid peach theme gradient (#f2ae66) instead of any green fallback, with a matching peach online-dot in chat headers.',
    ],
  },
  {
    version: '1.2.113',
    title: 'Fix dashboard script stall from Zion bubble formatting',
    sections: ['zion', 'overview'],
    items: [
      'Fixed a syntax break in Zion chat bubble formatting (`**bold**` / newlines) that lived inside the dashboard HTML template literal and stopped the whole page script — refresh polls and UI updates look frozen until reload after deploy.',
    ],
  },
  {
    version: '1.2.112',
    title: 'Zion voice v2 + typing indicator',
    sections: ['zion'],
    items: [
      'Zion’s LLM voice is now fun, smart, slightly technical, and optimistic — shorter skimmable replies (no full dashboard dumps or endless bot essays).',
      'Chat shows “Zion is typing…” with a short natural delay before the reply appears; assistant bubbles render newlines and **bold** for easier reading.',
    ],
  },
  {
    version: '1.2.111',
    title: 'MARL thoughts in lane fight log',
    sections: ['microbots', 'overview'],
    items: [
      'When Multi-Agent RL is on, each Lane fight log row shows MARL team-manager thoughts: score boosts/trims, priority after reorder, and preference suggestions.',
      'Scanner size confidence and low-MC skip/size-down notes append to the same fight row so you can see how MARL steers micro-bots without changing TP/SL.',
    ],
  },
  {
    version: '1.2.110',
    title: 'Zion free multi-provider LLM',
    sections: ['zion'],
    items: [
      'Zion chat falls back automatically: Gemini (GEMINI_API_KEY / GOOGLE_API_KEY) → Groq (GROQ_API_KEY) → OpenAI → local analysis — never crashes without a reply.',
      'Default models: gemini-3.6-flash (then gemini-3.5-flash), Groq llama-3.3-70b-versatile (then llama-3.1-8b-instant); overrides via GEMINI_MODEL / GROQ_MODEL / OPENAI_MODEL.',
      'Presence shows “via Gemini / Groq / OpenAI / Local analysis”; each reply ends with a via-provider footer for history.',
    ],
  },
  {
    version: '1.2.109',
    title: 'Zion personality + Improvement Requests',
    sections: ['zion', 'alerts', 'knobs'],
    items: [
      'Zion speaks in a calm, friendly analyst voice: short greeting, direct answer, brief summary, and an optional follow-up — no more default raw Snapshot dumps (ask for raw/snapshot if you need it).',
      'Local fallback and OpenAI prompts share the same style rules; profile off / missing data is stated simply.',
      'Zion Improvement Requests: pending list under the agent, red review popup (Approve / Deny / Close), chat nudges, email to bondback2026@gmail.com, and approved/denied history on Config.',
    ],
  },
  {
    version: '1.2.108',
    title: 'Zion chat, tooltip clamp, MARL collapsed',
    sections: ['zion', 'microbots', 'overview'],
    items: [
      'Zion’s polished, role-based chat is now the first surface in the Zion tab, with the existing Semi-Autonomous controls and Change Request approvals intact.',
      'A compact peach Zion launcher now provides the same chat across the dashboard, with mobile sheet layout, unread nudges, and pending Change Request badges.',
      'Sitewide ? tooltips use fixed positioning with viewport clamp so left-edge tips (e.g. MARL) are no longer clipped; right edge, mobile width, and tip-below still work.',
      'Multi-Agent RL on Micro Bots starts collapsed by default (status badge + Enable stay in the header); expand via the summary like Automatic Profile Scoring.',
    ],
  },
  {
    version: '1.2.107',
    title: 'Soft MARL + Zion chat agent',
    sections: ['microbots', 'zion', 'learning'],
    items: [
      'Multi-Agent RL (Micro Bots): soft lane ranking, size confidence, and low-MC coordination with Low/Medium/High Influence Strength — never edits micro-bot TP/SL or self-learning.',
      'Zion tab Agent chat: read-only analyst (OpenAI-compatible or local). Semi-Autonomous queues global Change Requests for Approve/Reject only.',
    ],
  },
  {
    version: '1.2.106',
    title: 'Contained mint table actions',
    sections: ['overview'],
    items: [
      'Open and closed mint columns now keep the pump marker above compact Copy and Jup actions, preventing them from overlapping Buy MC.',
    ],
  },
  {
    version: '1.2.105',
    title: 'Trend Rider specialty entry unlock',
    sections: ['microbots', 'scanners', 'learning'],
    items: [
      'Trend Rider / Steady Compounder Jupiter|KOL specialty handoffs bypass Pump.fun-only and Require TA so mature organic names can enter; lane MC/age/volume floors still apply.',
      'Trend Rider floors widened to age ≥1.5h and MC ≥$75k (catalog + safe migrate from old 2h/$100k). Quiet Trend was often Pump.fun-only vs Jupiter organic — not Learning Mode.',
    ],
  },
  {
    version: '1.2.104',
    title: 'Pump.fun mint markers',
    sections: ['overview'],
    items: [
      'Open Positions, Open Trades, and Closed Trades now show a compact pump badge before Copy when the mint address ends in pump.',
    ],
  },
  {
    version: '1.2.103',
    title: 'Scalper exempt from Require TA setup',
    sections: ['microbots', 'learning', 'scanners'],
    items: [
      'Scanner Require TA no longer blocks the Scalper lane (or small-MC ≤$180k queue candidates); Learning Mode still does not bypass TA for other profiles.',
      'Micro Bots: Migration Sniper / Reversal show Paused (perf) when off after the v1.2.91 review; Bot Info clarifies LM vs pause vs TA.',
    ],
  },
  {
    version: '1.2.102',
    title: 'Packaged profit cash-register alert',
    sections: ['alerts'],
    items: [
      'Profitable closes now play the packaged cash-register recording from its 3-second mark at 50% volume; the synthesized profit chime has been removed.',
    ],
  },
  {
    version: '1.2.101',
    title: 'Single half-volume profit cash register',
    sections: ['alerts'],
    items: [
      'Profitable closes now use one original Web Audio cash-register cha-ching at a 50% master-gain ceiling; notification refreshes no longer add a second profit chime.',
    ],
  },
  {
    version: '1.2.100',
    title: 'Cleaner open-position token cells',
    sections: ['overview'],
    items: [
      'Open Positions and Open Trades now keep the Token cell to the ticker and status badges; risk, conviction, anti-rug flags, and technical entry context remain in Reason → More Info.',
    ],
  },
  {
    version: '1.2.99',
    title: 'Softer cash-register profit chime',
    sections: ['alerts'],
    items: [
      'Profitable closes now play a short, soft cash-register cha-ching: a metallic drawer clack followed by a bright bell ring.',
    ],
  },
  {
    version: '1.2.98',
    title: 'Spaced open-position columns',
    sections: ['overview'],
    items: [
      'Open Positions and Open Trades now contain long profile badges within their column and give TP/SL and Reason clearer separation on desktop.',
    ],
  },
  {
    version: '1.2.97',
    title: 'Clear profit-close cash chime',
    sections: ['alerts'],
    items: [
      'Profitable closes now use a clearer, slightly more present cash-register cha-ching while retaining the separate open and close sound preferences.',
    ],
  },
  {
    version: '1.2.96',
    title: 'Clearer open-position columns',
    sections: ['overview'],
    items: [
      'Open Positions and Open Trades remove the Trailing Stop column; its armed/active state, threshold, stop, and peak now appear in Reason → More Info.',
      'Mint now contains Copy and Jupiter actions only (Copy exposes the full contract address in its tooltip), while rebalanced columns prevent Name, TP/SL, and Reason from overlapping.',
      'Buy MC and Live MC are more distinct at a glance, with a stronger live-mark accent.',
    ],
  },
  {
    version: '1.2.95',
    title: 'Readable open-position values',
    sections: ['overview'],
    items: [
      'Open Positions and Open Trades now give Cost, PnL, and Mint more usable desktop space; full SOL and USD values wrap instead of being cut off.',
      'Mint addresses keep the compact form while Copy and Jupiter actions move below the address when needed.',
      'Position sort menus now use a dark, high-contrast native dropdown on Windows and other desktop browsers.',
    ],
  },
  {
    version: '1.2.94',
    title: 'Stable, desktop-fit open positions',
    sections: ['overview'],
    items: [
      'Open Positions and Open Trades now keep their existing rows during live price refreshes, preventing periodic table flicker and preserving expanded hold timestamps.',
      'Desktop position tables use fixed compact columns with no horizontal scrollbar at standard laptop widths; narrower desktop views temporarily hide Buy MC and 1h volume while retaining the live mark, PnL, risk controls, and sell action.',
    ],
  },
  {
    version: '1.2.93',
    title: 'Trade sorting and refined close sounds',
    sections: ['overview', 'alerts'],
    items: [
      'Open positions and closed trades can now be sorted by newest, oldest, PnL, or market cap; choose Set default to retain each table type’s order between dashboard visits.',
      'Profitable closes now use a brief, subtle two-tone cash-register chime; regular exit sounds are slightly louder while preserving Alerts preferences and mobile audio unlock behavior.',
    ],
  },
  {
    version: '1.2.92',
    title: 'Trade open / close alert chimes',
    sections: ['alerts'],
    items: [
      'New unique Web Audio chime when a position opens; subtler soft tone on close (profits still use the cash sound). Alerts toggles + mobile unlock / pending queue / haptic.',
    ],
  },
  {
    version: '1.2.91',
    title: 'Performance allocation + lane PnL learning fix',
    sections: ['microbots', 'learning', 'risk'],
    items: [
      'Paused Migration Sniper + Reversal Scalper by default (weak WR/PF in paper); dip_buyer size↑; scalper/MB size↓ + higher conviction; daily loss floor 0.5 SOL.',
      'Lane outcomes: keep opened fights until close (was evicting before dip/swing exits) + stricter winner↔profile PnL join.',
      'Exit mix: classify momentum fade / SL strings; self-learn expectancy winsorizes 1 extreme win+loss so LOOP outliers cannot dominate upgrades.',
    ],
  },
  {
    version: '1.2.90',
    title: 'Trend Rider / Steady Compounder cluster entry fix',
    sections: ['microbots'],
    items: [
      'Trend Rider + Steady Compounder: specialty-feed stamps no longer fail the 2-wallet cluster gate (Jupiter/scanner 1-wallet handoffs).',
      'Bake defaults realigned to catalog (requireCluster off, min wallets 1); one-shot migration clears the old bake signature. Conviction/WQ quality floors unchanged. Learning Mode untouched.',
    ],
  },
  {
    version: '1.2.89',
    title: 'GitHub Backup auto-import defaults ON',
    sections: ['backup'],
    items: [
      'Back Up → GitHub Backup: Auto import on deploy now defaults to ON when unset; an explicit OFF stays OFF. GITHUB_BACKUP_AUTO_IMPORT=1 still force-enables for wipe recovery.',
    ],
  },
  {
    version: '1.2.88',
    title: 'GitHub Backup auto-import on deploy',
    sections: ['backup'],
    items: [
      'Back Up → GitHub Backup: enable Auto import on deploy (or GITHUB_BACKUP_AUTO_IMPORT=1) to restore the latest remote backup after listen when the SHA is new — dashboard stays up first.',
    ],
  },
  {
    version: '1.2.87',
    title: 'Fix dashboard blank screen',
    sections: ['overview', 'microbots', 'backup'],
    items: [
      'Bot Performance row click handler used broken quote escaping inside the dashboard script, which threw a JS parse error and stopped the whole UI from loading — fixed.',
    ],
  },
  {
    version: '1.2.86',
    title: 'Unstall dashboard performance polls',
    sections: ['overview', 'microbots'],
    items: [
      'Micro Bot Performance no longer runs on every strategies/intelligence poll — only when the Bot Performance tab is open (plus a short server cache), so the main dashboard stops stalling.',
    ],
  },
  {
    version: '1.2.85',
    title: 'Learning Mode bulb OFF vs ON colours',
    sections: ['overview', 'learning'],
    items: [
      'Header Learning Mode bulb stays visible: muted outline when OFF; filled Pause peach (#F1BB72) only when ON.',
    ],
  },
  {
    version: '1.2.84',
    title: 'Bot Performance under cog menu',
    sections: ['microbots', 'overview'],
    items: [
      'Micro Bot Performance is a dedicated cog-menu tab (Bot Performance) with the full rankings table; Micro Bots keeps an Open Performance shortcut.',
    ],
  },
  {
    version: '1.2.83',
    title: 'Micro Bot Performance metrics & ranking',
    sections: ['microbots', 'learning', 'overview'],
    items: [
      'New Micro Bot Performance card: WR, W/L, PnL (SOL+USD), profit factor, max drawdown, hold, best/worst, streaks, and Learning Mode participate + LM trade counts.',
      'Time filters Today / 24h / 7d / All; ranks by Profit Factor → Win Rate → Net PnL → Max DD. Merges closed trades with durable learning episodes (beyond the 200-row closed cap).',
      'Top/underperformer colouring, green/red streak chips, and #rank · streak line on each Micro Bot card.',
    ],
  },
  {
    version: '1.2.82',
    title: 'Per-profile Learning Mode opt-in + peach bulb',
    sections: ['overview', 'learning', 'microbots'],
    items: [
      'Each Micro Bot has Participate in Learning Mode (default ON) — softens that bot’s entry floors/fairness/stamps only when Global LM is ON; separate from Self-Learning deltas.',
      'Under Smart Bot Profiles, LM conviction/WQ/cluster soften is scoped to opted-in bots (no blanket global min overlays). Concurrent/rate + sniper/bundler max softens stay global.',
      'Header Learning Mode ON indicator is a filled bulb in Pause peach (#F1BB72); tip/banner show opted-in bot count. Closed-trade LM marks stay outline.',
    ],
  },
  {
    version: '1.2.81',
    title: 'Hide sound unlock chip on desktop',
    sections: ['alerts', 'overview'],
    items: [
      '“Tap to enable sounds” no longer shows on desktop — silent gesture unlock keeps alert chimes working without the header chip.',
      'On mobile/iPhone the chip only appears if a chime was blocked and audio is still locked; any tap still auto-unlocks when possible (Safari cannot unlock with zero gesture).',
    ],
  },
  {
    version: '1.2.80',
    title: 'Block phantom Dip Buyer take-profit marks',
    sections: ['microbots', 'execution'],
    items: [
      'Paper marks now reject early phantom pumps (price green while Dex MC flat) and clamp marks that lead MC by ≥8pp — stops Full TP / inflated Exit MC when Jupiter never printed the move.',
      'Dex native vs USD: prefer USD on >25% diverge, else the lower mark; live refresh ceilings green Dex marks with Jupiter when available.',
    ],
  },
  {
    version: '1.2.79',
    title: 'Learning Mode mark on closed trades',
    sections: ['overview', 'learning', 'microbots'],
    items: [
      'Closed Trades show a compact bulb icon on rows opened under Learning Mode (strictness in tooltip; also in Reason → More Info).',
      'Self-learning save journal tags each closed episode as LM Middle/Stricter/Looser or non-LM, with learningMode fields in export CSV/JSON.',
    ],
  },
  {
    version: '1.2.78',
    title: 'Compact Learning Mode header badge',
    sections: ['overview', 'learning'],
    items: [
      'Header Learning Mode is now a compact bulb icon (tooltip shows Middle/Stricter/Looser); Risk On/Off star badge removed from the top status bar to free space.',
    ],
  },
  {
    version: '1.2.77',
    title: 'Learning Mode softens gates correctly',
    sections: ['learning', 'microbots', 'risk'],
    items: [
      'Middle/Looser now blend with your live baselines (never raise conviction/WQ/cluster mins or tighten sniper/bundler maxes). Fixes Learning Mode accidentally setting conviction ~73 over soft micro-bot floors.',
      'Middle/Looser also raise effective Max Positions (≥16 / ≥24) and soften trade-rate at runtime without changing the Max Positions slider or SOL size.',
      'Profile match conviction/WQ aligned with the same soft blend; Settings tip clarifies throughput vs sizing.',
    ],
  },
  {
    version: '1.2.76',
    title: 'Micro-bot Learning Mode',
    sections: ['learning', 'microbots', 'risk'],
    items: [
      'New Learning Mode in Settings (near Risk): ON/OFF, Stricter/Middle/Looser slider, Reset with snapshot restore. Default OFF; does not change position sizing.',
      'When ON, overlays entry gates (conviction, cluster, WQ, sniper/bundler, top10, MC/liq/age) and fairness-boosts low-episode bots among passers only.',
      'Self-learn: Global TP pauses TP/SL exit deltas (entry continues); tighter ±5% patch clamps; multi-step rollback stack; small loosen entry deltas when evidence supports.',
    ],
  },
  {
    version: '1.2.75',
    title: 'Utility lane debug instrumentation removed',
    sections: ['execution'],
    items: [
      'Temporary Utility RPC debug ingest/logging removed after verifying sandwich/anti-rug no longer land on the Utility lane.',
    ],
  },
  {
    version: '1.2.74',
    title: 'Keep sandwich/anti-rug off Utility lane',
    sections: ['execution', 'copy'],
    items: [
      'With 0 Favourites watched, Utility high latency was mostly preferred-endpoint health probes plus ungated sandwich/anti-rug/dev-activity getParsedTransaction calls under Share load.',
      'MEV sandwich checks now use Critical (Helius); anti-rug/dev activity use Scanners (Alchemy) so Utility stays free for Favourites soft-watch.',
    ],
  },
  {
    version: '1.2.73',
    title: 'Utility prefers official mainnet-beta',
    sections: ['execution', 'copy'],
    items: [
      'Utility sticky preferred is now api.mainnet-beta.solana.com; publicnode and Triton remain failover options under Share load.',
    ],
  },
  {
    version: '1.2.72',
    title: 'No baked favourites on fresh deploy',
    sections: ['copy', 'execution'],
    items: [
      'Boot no longer auto-imports Favourites / Nansen seed when the watch list is empty — fresh deploys start with 0 tracked wallets so Utility soft-watch is not choked.',
      'Optional CLEAR_WATCHED_WALLETS_ON_BOOT=1 clears persisted watched wallets once on boot (then unset the env). Or use Reset Wallet Tracker in the UI.',
    ],
  },
  {
    version: '1.2.71',
    title: 'Stop token-metrics choking Utility RPC',
    sections: ['execution', 'copy'],
    items: [
      'Holder/top-10 on-chain metrics (getTokenLargestAccounts) now run on Alchemy under Share load with short timeouts — they were timing out ~15s on Utility and starving Favourites polls.',
      'Utility preferred is publicnode again (Triton stays as failover); stressed preferred Utility is probed less while soft-failed over.',
    ],
  },
  {
    version: '1.2.70',
    title: 'Utility soft watch RPC cap 30',
    sections: ['execution', 'copy'],
    items: [
      'With Share RPC load ON, the utility soft-watch wallet cap defaults to 30 (was 50) to ease Triton/public RPC pressure on Favourites buy watch.',
    ],
  },
  {
    version: '1.2.69',
    title: 'Utility prefers Triton api.mainnet.solana.com',
    sections: ['execution', 'copy'],
    items: [
      'Utility sticky preferred is now api.mainnet.solana.com (Triton) when set as RPC_URL or RPC_SECONDARY, then publicnode.',
      'Official api.mainnet-beta.solana.com is no longer chosen as a Utility soft-failover target (probe latency looked fake-fast).',
    ],
  },
  {
    version: '1.2.68',
    title: 'Utility soft-failover to QuickNode under load',
    sections: ['execution', 'copy'],
    items: [
      'When Utility public RPC EWMA stays ≥1000ms and no faster public/fallback exists, Utility may soft-fail onto QuickNode — only if QuickNode is healthy and not already serving Critical or Scanners failover.',
      'Normal Utility traffic still prefers publicnode; Alchemy/Helius remain the hard-fail paid piggybacks.',
    ],
  },
  {
    version: '1.2.67',
    title: 'QuickNode mid-tier RPC failover',
    sections: ['execution', 'copy'],
    items: [
      'Optional QuickNode sits between Helius/Alchemy and public endpoints for Critical and Scanners failover.',
      'When preferred lanes recover, traffic returns sticky; Utility stays on publicnode so Favourites soft-watch does not burn QuickNode CU.',
    ],
  },
  {
    version: '1.2.66',
    title: 'Utility prefers publicnode over mainnet-beta',
    sections: ['execution', 'copy'],
    items: [
      'Utility lane now prefers solana-rpc.publicnode.com by default — official api.mainnet-beta.solana.com is last-resort only (often 1s+ from Render).',
      'Inactive public fallbacks are probed rarely so a slow mainnet-beta row no longer dominates the Multi-RPC table.',
    ],
  },
  {
    version: '1.2.65',
    title: 'Public rpc-url latency soft-failover',
    sections: ['execution', 'copy'],
    items: [
      'Public Solana (rpc-url) uses a 5s latency soft-failover grace (faster than paid lanes).',
      'When rpc-url stays slow, Utility prefers a faster public/fallback (e.g. publicnode) before Alchemy, and probes the hot public endpoint less often while stressed.',
    ],
  },
  {
    version: '1.2.64',
    title: 'Helius latency EWMA + soft failover',
    sections: ['execution', 'copy'],
    items: [
      'RPC endpoint latency uses a smoothed average so one slow migration getTransaction no longer paints Helius as 800ms+.',
      'If primary EWMA stays above 500ms for 15s, critical traffic soft-fails over to a faster healthy lane (usually Alchemy) until Helius recovers.',
    ],
  },
  {
    version: '1.2.63',
    title: 'Soft-watch rotate + Clear list labeling',
    sections: ['copy', 'overview', 'execution'],
    items: [
      'Soft-watch cap (50) keeps hot wallets sticky and rotates colder wallets through remaining slots so Favourites are not permanently ignored.',
      'Closed Trades control relabeled Clear list with a stronger confirm — distinct from Overview Reset / Full Reset (which wipe opens).',
    ],
  },
  {
    version: '1.2.62',
    title: 'Utility soft watch RPC cap 50',
    sections: ['copy', 'execution'],
    items: [
      'With Share RPC load ON, the public utility soft-watch wallet cap defaults to 50 (was 75) to ease public RPC pressure.',
    ],
  },
  {
    version: '1.2.61',
    title: 'Clear closed trades (session only)',
    sections: ['overview', 'microbots'],
    items: [
      'Closed Trades panels (Overview + Trades) have a subtle Clear button that wipes session closed history only.',
      'Micro-bot learning episodes and self-learning data are preserved — Clear does not call any learning reset.',
    ],
  },
  {
    version: '1.2.60',
    title: 'Steady Compounder / HWR rug concentration harden',
    sections: ['microbots', 'execution'],
    items: [
      'RugCheck single-holder / high holder correlation risks hard-skip (no longer score-only).',
      'Steady Compounder + High Win-Rate fail-closed when insider or top-10 % is unknown after fetch; reject near-zero pro-trader % when known.',
    ],
  },
  {
    version: '1.2.59',
    title: 'Overview Active Profiles collapse on mobile',
    sections: ['overview', 'microbots'],
    items: [
      'On mobile, Active Trade Profiles collapses to the header + status line; tap to expand the profile chips.',
    ],
  },
  {
    version: '1.2.58',
    title: 'Settings Control Center mobile layout',
    sections: ['risk', 'knobs'],
    items: [
      'Settings Control Center keeps the modules ON count in the top-right on mobile (title row), instead of stacking under the buttons.',
    ],
  },
  {
    version: '1.2.57',
    title: 'Bot Info section update counters',
    sections: ['overview', 'alerts'],
    items: [
      'Bot Info chips show a blue unread count when that chapter has new What’s New items after a deploy or manual push.',
      'Opening a section clears its counter (per-browser localStorage).',
    ],
  },
  {
    version: '1.2.56',
    title: 'Peach warning buttons',
    sections: ['overview', 'knobs'],
    items: [
      'Pause / Reset / Prune / Clear warning buttons use peach #F1BB72 with dark text for clearer contrast.',
    ],
  },
  {
    version: '1.2.55',
    title: 'Settings menu: Backtester up',
    sections: ['backtester', 'knobs'],
    items: [
      'Cog menu order: Smart Wallets → Backtester → Settings → Config → Back Up → Bot Info.',
    ],
  },
  {
    version: '1.2.53',
    title: 'Logs under Config',
    sections: ['alerts', 'knobs'],
    items: [
      'Trade Logs and System / Fetch Errors moved to the bottom of Config; Logs removed from the cog menu.',
    ],
  },
  {
    version: '1.2.52',
    title: 'Safari / mobile alert sounds',
    sections: ['alerts'],
    items: [
      'Tap-to-enable sounds chip, pending chime queue, and Place Trade unlock for Safari/iOS autoplay rules.',
    ],
  },
  {
    version: '1.2.51',
    title: 'Micro Bots header trim',
    sections: ['microbots'],
    items: [
      'Removed the redundant MICRO BOTS / Risk On banner from the Micro Bots tab.',
    ],
  },
  {
    version: '1.2.50',
    title: 'Overview profile chip pause',
    sections: ['overview', 'microbots'],
    items: [
      'Double-click an Active Trade Profiles chip to Pause/Resume with confirm; module hover removed on Overview only.',
    ],
  },
  {
    version: '1.2.49',
    title: 'Session in header',
    sections: ['overview'],
    items: [
      'Session badge moved next to RPC; Overview Active Profile strip and header Day PnL removed as duplicates.',
    ],
  },
  {
    version: '1.2.48',
    title: 'Entries open count + scoring collapse',
    sections: ['overview', 'microbots'],
    items: [
      'Entries card matches Signals layout with a large open-trades count.',
      'Automatic Profile Scoring starts collapsed on desktop and mobile.',
      'Live Sim corner badges: green = open in profit, red = not in profit.',
    ],
  },
  {
    version: '1.2.47',
    title: 'Watchlists on Live Feed + Zion first',
    sections: ['scanners', 'microbots'],
    items: [
      'Dip setup, Graduation watchlist, and skip-reason diagnostics moved to the top of Live Feed.',
      'Smart Bot cards pin Zion first and hide Default in the UI (backend Default kept).',
    ],
  },
  {
    version: '1.2.44',
    title: 'Smart Bot card visuals',
    sections: ['microbots'],
    items: [
      'Profile cards: SVG battle-bot avatars, Details accordion for params, glow/hover polish, mobile snap carousel.',
    ],
  },
  {
    version: '1.2.30',
    title: 'Bot Info changelog + RPC docs',
    sections: ['overview', 'execution', 'backup'],
    items: [
      'Bot Info What’s New is driven from a structured changelog (check:botinfo requires the current package version).',
      'RPC settings docs cover multi-lane failover and what traffic uses Solana RPC.',
    ],
  },
];

export function botInfoChangelogVersions(): string[] {
  return BOT_INFO_CHANGELOG.map((e) => e.version);
}

export interface BotInfoChangelogItemRef {
  id: string;
  version: string;
  section: BotInfoSectionId;
  text: string;
}

/** Flatten changelog into per-section item refs (one ref per item × section). */
export function flattenBotInfoChangelogItems(): BotInfoChangelogItemRef[] {
  const out: BotInfoChangelogItemRef[] = [];
  for (const entry of BOT_INFO_CHANGELOG) {
    entry.items.forEach((text, i) => {
      const baseId = `${entry.version}:${i}`;
      for (const section of entry.sections) {
        out.push({
          id: `${baseId}@${section}`,
          version: entry.version,
          section,
          text,
        });
      }
    });
  }
  return out;
}

export function countNewBotInfoItemsBySection(
  seenIds: ReadonlySet<string> | readonly string[]
): Record<BotInfoSectionId, number> {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds);
  const counts = {} as Record<BotInfoSectionId, number>;
  for (const id of BOT_INFO_SECTION_IDS) counts[id] = 0;
  for (const item of flattenBotInfoChangelogItems()) {
    if (!seen.has(item.id)) counts[item.section] += 1;
  }
  return counts;
}

/** JSON payload embedded in the dashboard for client badge logic. */
export function botInfoChangelogClientPayload(): {
  items: { id: string; section: string; version: string; text: string }[];
} {
  return {
    items: flattenBotInfoChangelogItems().map((x) => ({
      id: x.id,
      section: x.section,
      version: x.version,
      text: x.text,
    })),
  };
}
