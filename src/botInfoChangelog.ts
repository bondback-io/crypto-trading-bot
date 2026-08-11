/**
 * Structured Bot Info "What's New" changelog.
 *
 * Add a new entry at the top when you ship a user-visible feature/fix.
 * Tag `sections` with Bot Info chip ids so unread counters can light up.
 * check:botinfo fails if package.json version is missing from this catalog.
 */

export const BOT_INFO_SECTION_IDS = [
  'lifecycle',
  'overview',
  'modes',
  'risk',
  'microbots',
  'learning',
  'tradecraft',
  'coaches',
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
    version: '1.2.283',
    title: 'Unstick Favourites polls + stop status-driven RPC thrash',
    sections: ['overview', 'copy', 'execution'],
    items: [
      'Utility gate no longer treats lifetime skipped as permanent stress — Favourites/soft-watch polls resume after early boot skips.',
      'Share+Utility no longer pins dead publicnode forever; /api/status stops mutating adaptive load (health tick owns it).',
      'Ignore EPIPE/ECONNRESET in process handlers so broken-pipe write storms cannot flood notifications and stall the event loop.',
    ],
  },
  {
    version: '1.2.282',
    title: 'Safe dual Helius/Alchemy pools + latency thrash guards',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Restores Helius/Alchemy primary+backup pools (HELIUS/ALCHEMY_RPC_URL + _BACKUP) with in-pool RR reads and sibling-first failover.',
      'Paid soft-latency arms at 1400ms with 90s sticky; /api/status is read-only (no resolve side effects) to stop Render failover thrash.',
      'Utility prefers publicnode over official mainnet-beta; Stats → RPC shows primary/backup share status again.',
    ],
  },
  {
    version: '1.2.281',
    title: 'Revert dual RPC pools — back to Helius/Alchemy keys',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Removed Helius/Alchemy primary+backup pool routing and in-pool round-robin that caused failover thrash.',
      'Restored classic single-endpoint config: HELIUS_API_KEY + ALCHEMY_API_KEY (Share load still splits Critical/Scanners/Utility).',
      'HELIUS_RPC_URL / ALCHEMY_RPC_URL still work as one endpoint each; *_BACKUP env vars are ignored.',
      'Stats → RPC Health shows one pill per provider again (no backup share status).',
    ],
  },
  {
    version: '1.2.280',
    title: 'Sanitize HELIUS/ALCHEMY_RPC_URL paste (whitespace + api-key typo)',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Strip newlines/spaces from pasted RPC URLs; auto-repair Helius ?api-key- → ?api-key=.',
      'Docs: Render HELIUS_RPC_URL must use equals after api-key and stay on one line.',
    ],
  },
  {
    version: '1.2.279',
    title: 'Stop RPC latency failover thrash (Render lag/crashes)',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Paid RPC soft-failover threshold raised (~1.4s); sibling flip only if meaningfully faster; 90s sticky after latency failover.',
      'Throttle rpc_failover_to_backup logs; /api/status no longer side-effects resolve/failover every poll.',
      'Dashboard backs off refresh under RPC stress; positions poll uses fast path; call-meter map capped.',
    ],
  },
  {
    version: '1.2.278',
    title: 'Fix bad RPC URL coercion + clearer pool health',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Do not wrap host/path strings as API keys (prevents broken double Helius/Alchemy URLs).',
      'Provider down chip only when all configured paid pools are down; one pool down shows Failover active.',
      'RPC Health shows error detail (auth/timeout/…) so bad keys are visible.',
    ],
  },
  {
    version: '1.2.277',
    title: 'Coerce bare keys in HELIUS/ALCHEMY_RPC_URL env',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'HELIUS_RPC_URL / ALCHEMY_RPC_URL (+ backups) accept full https URLs or bare API keys (auto-wrapped).',
      'Strips wrapping quotes; Stats → RPC explains when env is present but not loaded.',
    ],
  },
  {
    version: '1.2.276',
    title: 'Stats mobile UX + Export timeout + quieter persistence banners',
    sections: ['overview', 'knobs', 'backup'],
    items: [
      'Stats tab strip: scroll arrows jump to start/end; RPC Health stacks cleanly on mobile.',
      'Export Data / Learning Report leads and controls use full-width stacked layout on mobile.',
      'Export/Learning report client timeout raised to 90s; no auto-generate on tab open; clearer timeout errors.',
      'Removed page-bottom DATA_DIR disk-not-mounted banner and boot toast; Backup tab keeps calm status.',
    ],
  },
  {
    version: '1.2.275',
    title: 'RPC backup env hardening + health labels',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Boot/failover logs: rpc_env_loaded, rpc_backup_loaded, rpc_backup_unset, rpc_failover_to_backup, rpc_failover_to_provider.',
      'Stats → RPC shows primary configured / backup ready vs backup unset; solo only when backup truly missing.',
      'Invalid or duplicate backup URLs fail soft into solo without breaking routing.',
    ],
  },
  {
    version: '1.2.274',
    title: 'Render RPC URL env + backup share status',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Accepts HELIUS_RPC_URL / HELIUS_RPC_URLBACKUP and ALCHEMY_RPC_URL / ALCHEMY_RPC_URL_BACKUP (API key env still works).',
      'Stats → RPC shows Helius/Alchemy primary+backup pills with sharing vs failover status lines.',
      'Share-load default ON when both provider URLs (or keys) are set; .env.example documents Render URL names.',
    ],
  },
  {
    version: '1.2.273',
    title: 'Dashboard-reset learning hygiene + Plan-mode Cursor package',
    sections: ['learning', 'overview', 'knobs'],
    items: [
      'dashboard_reset closes are stamped learningQuarantined and excluded from self-learn / RL / expectancy (reversible via includeDashboardResetEpisodes).',
      'One-shot historical quarantine of existing reset episodes; Learning Report notes excluded count.',
      'Copy Cursor package now starts with Plan-mode-only evaluation instructions before the report body.',
    ],
  },
  {
    version: '1.2.272',
    title: 'Learning Report on Stats → Export Data',
    sections: ['learning', 'overview', 'knobs'],
    items: [
      'Stats → Export Data: Generate Learning Report (last 50/100) with summary, per-profile table, trade sample, diagnostics, and learning config snapshot.',
      'Copy report, Copy Cursor package (fixed evaluation preamble), Download .md / .json — read-only; existing system diagnostics export unchanged.',
    ],
  },
  {
    version: '1.2.271',
    title: 'Stats → RPC consolidates health + endpoint table',
    sections: ['overview', 'execution', 'knobs'],
    items: [
      'Moved Overview RPC Health and Config RPC Status into Stats → RPC (one combined section).',
      'Endpoint table lists all RPCs including Helius/Alchemy backups (lane/slot labels); solo no longer duplicates onto the backup pill.',
      'Config keeps MEV/Jito knobs with a link to Stats → RPC.',
    ],
  },
  {
    version: '1.2.270',
    title: 'Dual free-tier RPC pools + Overview RPC Health',
    sections: ['overview', 'execution', 'zion', 'knobs'],
    items: [
      'Helius/Alchemy primary+backup pools via HELIUS_RPC_URL(_BACKUP) / ALCHEMY_RPC_URL(_BACKUP) or existing API keys; in-pool RR + sibling-first failover.',
      'Overview RPC Health panel (chips + pool pills) from /api/status; Zion uses pool plainLanguage one-liners.',
      'Optional RPC_TIMEOUT_MS / RPC_MAX_RETRIES / RPC_HEALTH_COOLDOWN_MS / RPC_HEALTH_PROBE_INTERVAL_MS; send prefers healthiest paid endpoint.',
    ],
  },
  {
    version: '1.2.269',
    title: 'Unstick armed signal path (MC unknown + Entry Skill)',
    sections: ['overview', 'microbots', 'scanners', 'learning'],
    items: [
      'Armed setup watches soft-pass unknown MC on Min MC Override (global $8k + anti-rug still final); known-below-min stays hard.',
      'Governed armed soft-open no longer treats Min MC Override / unknown MC text as safety-hard (fixes blocked_second_pass freeze).',
      'Zero-MFE pattern skip exempts armed_trigger; scratchy shorts filtered from the DOA share sample.',
      'Steady/HWR empty-arm disc relief restored under E-boost; soft-movement vol floors aligned with softEligible.',
    ],
  },
  {
    version: '1.2.268',
    title: 'Expectancy Repair Pack (40–45% path)',
    sections: ['overview', 'microbots', 'learning', 'tradecraft', 'scanners'],
    items: [
      'Entry Skill: historical zero-MFE pattern admit skip + earlier stall cut; under E-boost quality/Trend use strict 10% disc cap (no 20% floor).',
      'Dip governor: native soft-allow counters + milder restricted haircut; Dip top-loss size-down when Dip ≥25% of abs losses.',
      'Harvest: faster PPP giveback (28%), earlier MS/MB banks, stronger tiny-green scratch block (MFE≥6), Scalper/MB tighter fade; learning penalises zero-MFE + green→red.',
      'Steady/HWR: soft-movement tier (range≥1.5% or H1≥0.7 + vol alive) with size ×0.85 and ≤3 concurrent soft arms; dead tape still denied.',
      'Diagnostics: Expectancy Lift + Learning Metrics chips for 0-MFE / green→red / Dip soft-allow / soft-move / top-loss; Export snapshot repair line.',
    ],
  },
  {
    version: '1.2.267',
    title: 'Export Data enrichment for AI upgrades',
    sections: ['overview', 'microbots', 'learning', 'tradecraft'],
    items: [
      'Stats → Export Data now includes Target Gap, Exit/Harvest, Entry Timing, Size/Risk, Lane Inventory, and Learning Mutation sections (plain-text, read-only).',
      'Adds WR/armed/late-chase/capture/avgW·avgL gaps, exitReason %, 0-MFE and green-then-red rates, arm→trig / trig→open latencies, concurrent + loss share, Dip/Steady/HWR lane counters, episode fill / lastMutation / FPR stages.',
    ],
  },
  {
    version: '1.2.266',
    title: 'Expectancy killers repair · Export Data',
    sections: ['overview', 'microbots', 'learning', 'tradecraft', 'scanners'],
    items: [
      'Entry Skill: E<0 bumps effective armed target to 90%; late-chase reclaim relief denied when E≤−0.75; Dip comparative soft-allow when support_dip_reclaim is restricted but native Dip beats peers.',
      'Armed trigger→open: non-safety floor soft-pass for all setup-watch families; governed fail-open soft lane fight (anti-rug/MC still hard). Funnel shows arm→trig→open conversion + family restriction impact.',
      'Harvest/loss: Migration size-down + earlier bank; tighter fast PPP giveback; faster 0-MFE stall; learning rewards capture/expectancy and penalises scratchy soft-exits. Steady/HWR movement gates eased; RL shadow no longer permanently zeros sample flow.',
      'Rankings Max DD capped/floored like Overview. New Stats → Export Data tab: read-only AI-readable system report (Generate / Copy).',
    ],
  },
  {
    version: '1.2.265',
    title: 'Stats Learning Metrics tab',
    sections: ['overview', 'microbots', 'learning', 'scanners'],
    items: [
      'New Stats → Learning Metrics tab: per-profile readiness, EMA, capture, armed quality, funnel mini-stats, and promotion blockers (Last 20/50/100). Read-only join of Expectancy / Profile RL / Trade Craft / Learning diagnostics.',
      'Zion can summarize Learning Metrics in plain language (healthy / weak / quiet). Existing Learning diagnostics tab unchanged.',
    ],
  },
  {
    version: '1.2.264',
    title: 'Watchlist tabs · Stats nav · quality name gates',
    sections: ['scanners', 'overview', 'microbots'],
    items: [
      'Watchlist split into Setups / Scanner / Activity tabs; Setups further pills Dip/Steady · Mode B · Trend · Grad · Mirror · Skips so the page stays scannable.',
      'Bot Performance moved to main nav as Stats (right of Micro Bots); Trades tab hidden. Bot Info / Zion / digest copy updated.',
      'Steady medium parks: $20M–$200M floor; name exclusions for stables / major proxies / stock-like tickers; rotate excluded and out-of-band watches. Dip minors unchanged.',
    ],
  },
  {
    version: '1.2.263',
    title: 'Steady/HWR medium-major arm playbooks · live tape',
    sections: ['scanners', 'microbots', 'overview', 'tradecraft'],
    items: [
      'Steady + HWR unique medium/major playbooks on shared quality parks (tags steady_structure_arm / hwr_quality_arm). HWR stamp when stronger confluence/quality floors pass; Dip minors unchanged.',
      'Active-movement gate + dead-tape rotation so low-movement high-MC names leave inventory; Steady/HWR funnel boards + Zion plain language. Scalper/late-chase untouched.',
    ],
  },
  {
    version: '1.2.262',
    title: 'Dip Buyer minor-lane recovery · filter-leak fences',
    sections: ['scanners', 'microbots', 'overview', 'tradecraft'],
    items: [
      'Dip minors: force dip_buyer identity, Trend yields on drop|near Fib/S, honest specialtyFeed, eager Fib seed, reserved status slots + full snapshot for one-setup sync. Jupiter specialty also offers Dip minor watches. Caps/floors unchanged; no Steady soft-arm on minors.',
      'Steady/HWR soft-allow + microcap NAP band-fenced to majors|medium; leak counters; Dip minor funnel + lane-compare + WR/E chips; starved/perf-collapse logs + Zion/DBR plain language. Scalper/late-chase untouched.',
    ],
  },
  {
    version: '1.2.261',
    title: 'Medium/Majors park inventory · Steady soft-arm',
    sections: ['scanners', 'microbots', 'tradecraft', 'overview', 'knobs'],
    items: [
      'Medium/Majors discovery widens Jupiter merge (toptraded/toptrending/toporganicscore across 1h–24h), watch-only age/vol/liq relax (30d floor, age-unknown fail-open, $40k liq, total H1 vol), caps 80/80, API/UI show full parks (no 16/28 truncate).',
      'Steady soft-arm when Fib/S levels exist (levels ready · waiting reclaim); eager level seed on park; wider near-band; skip no-levels rotate for steady_compounder until TTL. Reclaim still required to fire.',
    ],
  },
  {
    version: '1.2.260',
    title: 'Scalper armed-primary habit · Steady/HWR majors unlock',
    sections: ['microbots', 'tradecraft', 'risk', 'overview', 'knobs', 'learning'],
    items: [
      'Scalper habit always-on: discretionary skipped unless expanding vol + near support (armed Mode B reclaim primary). Logs scalper_armed_open / scalper_discretionary_skipped / scalper_size_downrank_active. Disc size↓ also when E<0; RL Shadow while weak/recovery/poor expectancy. Late-chase untouched.',
      'Steady/HWR soft-allow plumbing: age + vol/liq/holders passed at anti-rug / quality gate / executeBuy so aged majors stay age-known and buys do not re-deny. HWR majors|medium specialty pump bypass (Steady parity). Soft-allow grant/deny counters + HWR quiet chips.',
    ],
  },
  {
    version: '1.2.259',
    title: 'HWR/Steady soft-allow before anti-rug · microcap NAP',
    sections: ['microbots', 'tradecraft', 'risk', 'overview', 'knobs'],
    items: [
      'HWR/Steady top10 soft-allow now runs before anti-rug / quality holder / executeBuy concentration hard-kills; grant suppresses high-holder skip; deny keeps explicit soft-allow reason + leaf key (volume/ceiling/liquidity/holders/market_cap). RugCheck SAOF + insider hard caps unchanged.',
      'Microcap: HWR/Steady always silent NAP when known MC <$5M (armed watches included); cascade/anti-rug/executeBuy emit quality MC NAP instead of generic anti-rug MC-too-low on junk.',
      'Age-unknown soft-allow recalibrated: vol 1.0× lane min (HWR $15k / Steady $4k); soft ceiling 75%; keep liq $30k/$15k + size ×0.85. Late-chase + Scalper untouched.',
    ],
  },
  {
    version: '1.2.258',
    title: 'Harvest runners · Medium/Major Steady unlock',
    sections: ['microbots', 'tradecraft', 'scanners', 'overview', 'knobs', 'risk'],
    items: [
      'Quality harvest: Steady/Trend trail room (9%/5% · 10%/6%); PCL PPP wins over catalog when ON (arm 50 / giveback 42); Steady partial 28%/40%; armed quality early partial 14%@0.35; post-partial ×0.95. BE nudge 1.5% stays on fast/low/late only — hard SL / late-chase / Scalper untouched.',
      'Medium/Majors: hard age ≥60d + pump block (fail-closed unknown); H1 floors $12k/$20k; soft-gate Dip/Steady only; H1-vol rotation at cap 25 (1.25× + 10m debounce). Fix launchedAt≠watch birth so Steady/soft-allow see real pool age.',
      'Steady unlock: majors/medium pump bypass without armed gate; watch→arm→trigger logs [WATCHLIST-*]/[ROTATION]/[STEADY-COMPOUNDER]; size ×1.15 on high-conviction quality reclaim. maxConcurrent 1 kept.',
    ],
  },
  {
    version: '1.2.257',
    title: 'Master performance · late-chase disable · MS tighten · PCL harvest',
    sections: ['microbots', 'tradecraft', 'overview', 'knobs', 'risk', 'learning'],
    items: [
      'Late-chase: close flag-only Entry Skill bypass; 125-close force-disable countdown; 8% last-50 share cap; LC_* reason codes; MB+MS hardLateChase; detect ext 8%. Sticky restricted during countdown — never loosened.',
      'Migration Sniper: conviction 36 / WQ 35 / fire ≥92% / H1 $2.5k / buy $400 / size ×0.55 ≤0.10 SOL; PTA confluence 40; disc hard-skip when migration_hold_reclaim down_ranked/restricted unless Grad-armed; size habit ×0.65/×0.55.',
      'Entry Skill disc permission floor 42; PCL earlier arm (55%/52%) + tighter giveback (38%/35%) + higher early partial; post-partial giveback ×0.92; MFE chip floor 0; performanceRegimeMarker v1.2.257-perf for clean Last-50. Hard SL/anti-rug/Scalper untouched.',
    ],
  },
  {
    version: '1.2.256',
    title: 'HWR/Steady soft-allow · insider soft-pass · Steady med/maj arms',
    sections: ['microbots', 'tradecraft', 'scanners', 'overview', 'knobs'],
    items: [
      'Steady/HWR top10 soft-allow ceilings raised: aged Steady 68% / HWR 65%; age-unknown Steady 72% / HWR 70% (Steady unknown ceil was missing). Grant tag top10_soft_allow_age_known; keep vol×1.5 / liq / holders / MC checks + size ×0.90/×0.85. Late-chase + Scalper untouched.',
      'Quality holder gate: unknown insider/top10 soft-pass for Steady/HWR (failClosedUnknown false); log insider_unknown_soft_pass vs insider_known_block. Known ≥50% insider still hard-skip.',
      'HWR/Steady silent not_applicable when known MC <$5M (armed reclaim exempt); Steady prefer MC $50M. Dip funnel Steady med/maj diagnostics (seen/arm/trig/opened/expired + armNow). Steady/HWR disc not silenced by Scalper/MS arms alone when their own arms are empty.',
    ],
  },
  {
    version: '1.2.255',
    title: 'Bot Info tab compact nav · lifecycle layout',
    sections: ['lifecycle', 'overview', 'microbots', 'scanners', 'knobs', 'tradecraft'],
    items: [
      'Bot Info section nav: wrapping denser chips (no desktop horizontal scrollbar); mobile section select + 2-column touch chips.',
      'Lifecycle hero + flowchart centered full-width (contain, no cramped max-height); SVG tile grid recentered.',
      'Docs refreshed for Entry Skill / Admission Baseline, Power Cell, Steady non-pump + top10 soft-allow, watch readiness, Dip/Steady inventory, armed-or-fallback (through 1.2.254 themes).',
    ],
  },
  {
    version: '1.2.254',
    title: 'Watchlist readiness · Dip/Steady inventory fill',
    sections: ['microbots', 'tradecraft', 'scanners', 'overview', 'knobs'],
    items: [
      'Watchlist readiness: refresh on Watchlist open; 2s poll while Watchlist visible; window.refreshSetupWatches bound before bucket tabs; trade-profiles paint keeps last watchReadiness strip.',
      'Dip/Steady inventory: no Trend mutual-exclude for medium/majors (expire Trend → Dip park); minors may yield Trend when near Fib/S; Scalper/Mode B mutual-exclude unchanged; medium H1 floor $15k (majors $25k); funnel splits mxS/mxT + vol/liq/mc/noSet/maxD.',
      'Skips: HWR age-unknown top10 soft ceil 48% (aged stays 40%, size ×0.85); quality disc hard-skip floor max(cap,20%) while arms live (fast stays strict); armed Post-Run/specialty max age ≤36h only — late-chase + Steady maxConcurrent untouched.',
    ],
  },
  {
    version: '1.2.253',
    title: 'Steady non-pump quality opens · Dip/Steady funnel',
    sections: ['microbots', 'tradecraft', 'scanners', 'overview', 'knobs'],
    items: [
      'Steady/HWR non-pump quality allow: anti-rug + executeBuy honor specialty pass-through (Steady majors|medium|jupiter|kolscan armed/dip-trigger; HWR jupiter|kolscan only). Tag non_pump_quality_allow; buyPumpFunOnly stays hard for unstamped paths; honeypot/critical anti-rug final; Scalper/Migration/late-chase untouched.',
      'Medium specialty Require-TA exempt parity with majors for Steady/Trend handoffs.',
      'Dip/Steady watch funnel: top admit/rotate deny reasons (mutual_exclude, unwatch_cd, no_levels_rotate, vol/liq/MC, at_cap); CYCLE prefer near Fib/S; no-levels rotate softened to 4×20m (skip MC≥$500M).',
    ],
  },
  {
    version: '1.2.252',
    title: 'Soft-allow pool age · age-unknown fallback · MB N/A',
    sections: ['microbots', 'tradecraft', 'overview', 'knobs'],
    items: [
      'Steady/HWR top10 soft-allow: calendar/pool age (tokenAgeHours · pairCreatedAt · launchedAt; never migrationAgeMs) for ≥90d gate; age-unknown quality fallback (1.5× H1 vol, Steady 15k / HWR 30k liq, holders + MC floors) tagged top10_soft_allow_age_unknown_fallback with size ×0.85; aged path stays ×0.90.',
      'Momentum Burst: early not_applicable when no MB lane signals (preferred/DNA/vol+pressure) — cuts cascade noise like Migration Sniper; floors/scalp mode unchanged.',
      'Monitor MatchContext: pairCreatedAtMs plumbed for soft-allow age; known-young still deny; Scalper/Migration/late-chase/anti-rug untouched.',
    ],
  },
  {
    version: '1.2.251',
    title: 'Steady/HWR top10 soft-allow · WR classifier unify',
    sections: ['microbots', 'tradecraft', 'overview', 'learning', 'knobs'],
    items: [
      'Dip governor: audit only — stays restricted on negative expectancy; armed/native soft-pass unchanged (no unlock).',
      'Steady/HWR lane top10 soft-allow: aged (≥90d) liquid tokens between hard max and soft ceiling (42%/40%) with vol/holders floors; size ×0.90; tagged top10_soft_allow. Fast bots unchanged; unknown top10 fail-closed intact.',
      'WR unify: shared SOL classifier (win>0 / loss<0 / scratch excluded); microBot, Expectancy Lift, Trade Craft, paper lifetime seed aligned; Overview All tip when lifetime W/L overlays sample PF; PF ∞ label aligned.',
    ],
  },
  {
    version: '1.2.250',
    title: 'Watchlist inventory · Profile RL anti-thrash · status lights',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'One-setup parity: Dip support-breach + unwatch clear locks; throttled mint-held logs; TTL release + lock→opened/expired funnel counters. Remint-while-active TTL design unchanged.',
      'Profile RL: Shadow→Hybrid EMA≥0; anti-thrash ≥12 trades/6h (Lead ≥20/12h); Hybrid demote needs readiness drop or stability+EMA<0 (not stability alone); rlModeMax + manual auto-lock persist; plain-language blockers on Profile RL card.',
      'Dip/Steady inventory: medium/majors caps + CYCLE 25; time-gated no-levels rotate (~20m×3≈1h); skip rotate MC≥$500M until TTL; ~40% mid-MC (50m/100m) CYCLE seats. Arm/reclaim/Entry Skill unchanged.',
      'Watch readiness strip (Watchlist): green/amber/red for Dip-Steady, Trend, ModeB/Scalper, Migration, Smart Mirror, HWR + overall indicator (observe-only).',
    ],
  },
  {
    version: '1.2.249',
    title: 'Armed-first alignment · mix slider',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'Mix accounting: Trend armed watches count in liveTriggerableArmed; quality disc (Dip/Trend/Steady/HWR) hard soft-skipped with fast when disc > slider cap and arms live; stuck relief needs openRate evidence (openCount alone no longer zeros arms).',
      'Dip/Trend near-zero discretionary when quality arms live (structural disc only under fallback); Fib/S + trend-watch arm paths kept; Mode B confluence-now unchanged.',
      'monitor: trend-watch:triggered on armed/trigger regexes + setupWatchFamily trend on handoffs.',
      'Armed-mix slider entrySkillArmedTargetPct default 80 (clamp 60–90) → disc cap = 100−pct; persist + GET/POST; Expectancy Lift slider beside Entry Skill; chips + Zion one-liner. Observe-only under Baseline v235.',
    ],
  },
  {
    version: '1.2.248',
    title: 'Quiet watches · Steady Medium/Majors · Trend watchlist',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'Quiet-watch repair: Mode B arms on nearSupport||multi-TF||hits≥2; Dip-wins early offer so Mode B park cannot starve Fib dips; majors/medium deny stables, rotate !hasLevels, one-setup remint armed-only.',
      'Dip/Steady rename + Medium tab: Minors (Dip) · Medium $50–200M Steady · Majors ≥$200M Steady; separate caps ≤16/≤12/≤12.',
      'Steady doctrine: armed-only / near-zero disc, maxConcurrent 1, PCL ~25%/50%, RL Shadow until proven, PumpFun bypass for medium/majors specialty; stables denied.',
      'Trend Rider setup watch (≥$1M DNA): watch→arm→fire, cap ≤12, mutual exclusion vs Mode B + Steady parks; dashboard funnel; late-chase forbidden.',
      'Habit extend: Entry Skill late-chase hard-skip all profiles; Scalper tighter 0-MFE stall; MS concurrent≤1 when down_ranked; armed fast PCL earlier; learning down-weights stall spam; Lead block weak fast.',
    ],
  },
  {
    version: '1.2.247',
    title: 'Scalper + Migration habit filters (additive)',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'Scalper habit: when WR weak or Fast Recovery stage≤1, soft-skip discretionary admits unless Mode B armed/triggered or expanding volume + near support; armed handoffs unchanged. Concurrent/attention caps not raised.',
      'Scalper size: discretionary only — further expectancy size cut (×0.5–0.7) when recent WR <25% or PF low; armed Mode B keeps prior size path.',
      'Migration Sniper: Entry Skill hard-skips late_chase primary (with Scalper); discretionary dump/extension + missing hold-reclaim soft-zeros when not Grad-armed; fire-band/ultra-fresh + Grad armed preserved.',
      'MS size: migration_hold_reclaim down_ranked/restricted forces smaller size via expectancy soft-pass path. Dip/Steady/Trend admit doctrine + DISC_SHARE_CAP / armed-or-fallback unchanged; Baseline v235 kill-switch unchanged.',
    ],
  },
  {
    version: '1.2.246',
    title: 'Lock hygiene · Profile RL · Trend live tape · Steady majors',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'One-setup lock hygiene: Dip support-breach + unwatch clears; acquire log only on new mint; TTL deletes route through release log; lock_acquired/lock_released events. No TTL/remint/Entry Skill policy change.',
      'Profile RL: Shadow→Hybrid needs EMA≥0; Hybrid→Lead sustained; demote needs 2 confirming closes; ≥6 trades or ≥2h dwell (recovery Lead→Hybrid waived); rlModeMax enforced. Manual mode auto-locks; save chip + plain-language blockers; Profile RL ≠ ML label.',
      'Trend Rider: discretionary soft-skips collapsed/decaying tape unless M5/H1 uptick; KOL/Jupiter specialty may enter quieter tape; profile-only flat+collapsed soft exit after ~25m. Skip reasons stamped for self-learn.',
      'Steady Compounder: majors specialty PumpFun + Require-TA bypass (with Trend); majors ≥$250M dips soft-prefer Steady; anti-rug/stables/holder gates kept; rulesSummary updated. Learning/craft/RL unchanged.',
    ],
  },
  {
    version: '1.2.245',
    title: 'Entry Skill armed-or-fallback (trade starvation fix)',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'Armed-or-fallback disc mix: never freeze all discretionary — hard-skip only fast disc when triggerable arms exist + disc>30%; fallback ≤30% when arms empty/stuck (openRate<20% / thin book / elevated touch-fail); fast relief 45% only if still overtrading.',
      'Softer armed convert: reclaim 0.9%, touch-fail 1.8% (or off when openRate<20%); Grad fire 88% + touch-fail 2.0%; expire-loosen −25% TTL once after ≥3 unused expires; one-setup TTL 8m with release on expired/triggered/invalidated/profile-off + inactive prune.',
      'Scalper: concurrent≥1 only when Mode B arms live; attention 32%/window 30 (armed bypass). MS not_applicable (no cascade noise) without mig/curve signals; maxMigrationAgeSec 180s. Dashboard/Zion Entry Skill chips + blocked_second_pass counter. Late-chase + hard safety kept; Baseline v235 kill-switch unchanged.',
    ],
  },
  {
    version: '1.2.244',
    title: 'Power Cell on Micro Bots (mobile)',
    sections: ['microbots', 'tradecraft', 'overview', 'learning', 'knobs'],
    items: [
      'Performance Power Cell moved to top of Micro Bots tab (first card); removed from Bot Performance between Expectancy Lift and Trade Craft.',
      'Mobile: 2-column mini-cell grid (≤640px), stacked hero meta above full-width bar, wrapping header Window/Refresh, touch-friendly targets; window select syncs with Expectancy Lift Last 20/50/100.',
      'Visual-only; Entry Skill / Baseline v235 unchanged. Opening Micro Bots refreshes Power Cell via loadExpectancyLift.',
    ],
  },
  {
    version: '1.2.243',
    title: 'Performance Power Cell (visual)',
    sections: ['tradecraft', 'overview', 'learning', 'microbots', 'knobs'],
    items: [
      'Bot Performance: Performance Power Cell card (combined + per-profile minis) below Expectancy Lift — charge % from WR/expectancy/armed/MFE/late-chase blend; craft fallback when thin; Last 20/50/100 shared with Expectancy Lift.',
      'Visual-only: neon battery shell, target WR tick, delta chip, particles when improving, prefers-reduced-motion safe. Quiet/capped mini labels + Scalper attention penalty. No admit-path changes.',
      'Entry Skill remains default On (admissionBaseline=governed); Baseline v235 kill-switch unchanged.',
    ],
  },
  {
    version: '1.2.242',
    title: 'Entry Skill + Selectivity (default On)',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs', 'zion'],
    items: [
      'Entry Skill is the new default (admissionBaseline=governed): armed-first 70/30, late-chase quality hard-skip, Scalper 28%/window 20 + concurrent≥1, family skill memory on status. Kill-switch: Baseline v235 restores 1.2.235 observe-only admit throughput.',
      'evaluateEntrySelectivity facade in expectancyLift; monitor admit cascade uses one call. One-shot entrySkillDefaultV242 migrates leftover 1.2.241 v235 defaults unless operator already toggled.',
      'Grad watch touch→reclaim / touch-and-fail (v235 skips reject); one-setup locks sync for migration grad; PCL resolveExitPolicy passes armedWatch for earlier armed partials.',
      'Dashboard Entry Skill control (On / Baseline v235); family table WR/avg W/L/MFE; Dip quiet suppressed_by_scalper_attention + MARL; Trend funnel quiet + Zion plain language. If opens collapse → flip Baseline v235.',
    ],
  },
  {
    version: '1.2.241',
    title: 'Admission Baseline (restore 1.2.235 throughput)',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview', 'knobs'],
    items: [
      'Admission Baseline toggle (default v235): expectancy metrics/UI stay on; admit throttles off for 1.2.235-era open rate. Governed = full 1.2.240 late-chase / disc-mix / governor / permission / concurrent gates.',
      'v235: Scalper attention 35%/window 40, no concurrent=1; armed hard-lock fail-open to soft lane fight; Mode B/Dip skip touch-and-fail reject (1.2% reclaim kept); expectancy size ×1.0; sticky governors cleared on switch/ship.',
      'Dashboard Expectancy Lift card: Admission Baseline select + baseline chip; GET/POST /api/config/admission-baseline; status includes admissionBaseline + baselineActive.',
      'Staged re-enable under governed: (1) soft permission + size only → (2) disc-mix / late-chase ceilings → (3) governor soft-pass then hard restrict → (4) Scalper concurrent=1 + 30%/20 last. ≥20–40 closes per stage.',
    ],
  },
  {
    version: '1.2.240',
    title: 'Unblock lane winners (governor soft-pass)',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview'],
    items: [
      'Family governor: native-style soft-pass when restricted (permission/size down-rank); hard-skip late_chase + off-style only. admitFamily prefers profile DNA over scanner mig stamp.',
      'migration_hold_reclaim DNA narrowed (fresh-mig / armed grad / MS prefer); governor metrics count migration_sniper only; one-shot repairedV239 sticky restrict → down_ranked.',
      'Per-passer expectancy/attention: restricted top no longer kills the whole fight; cascade annotate on early expectancy skips. Late-chase ceiling uses >5% (exact 5% allowed).',
      'Dip handoff passes Fib/S/lastPrice; armed Dip DNA late_chase soft penalty (no hardZero); stamp prefers entryStyleHint over rediscovered late_chase.',
    ],
  },
  {
    version: '1.2.239',
    title: 'Dip watch fire + Smart Mirror status',
    sections: ['microbots', 'scanners', 'copy', 'tradecraft', 'overview'],
    items: [
      'Dip watch tick: recompute Fib/S proximity + drop from peak/H1; arm on levels (drop soft); reclaim trigger 1.2% Mode B parity; dipWatchTriggered stamp + Dip badge fallback.',
      'Armed Dip lane soft-pass holders/H1 floors after hard-lock; hard MC $8k / anti-rug stay final. Dip funnel counters in setup-watch diagnostics.',
      'Smart Mirror: default copy delay 75s; strip shows master ON/OFF, smart_money_copy + smart_money_mirror prereqs, wallet counts, recent skip reasons. No auto-bag mirror.',
      'Expectancy: late-chase ceiling needs ≥20 closes (fresher last-20); armed reclaim ≤4% not hard-skip; stuck-armed disc relief 45%; clearer single-lane fail text.',
    ],
  },
  {
    version: '1.2.238',
    title: 'Governor bottleneck repair',
    sections: ['microbots', 'tradecraft', 'learning', 'scanners', 'overview'],
    items: [
      'Expectancy governors: window fingerprint stops poll inflation of negWindows; one-shot sticky restrict → down_ranked repair; scratch / non-finite PnL excluded from governor metrics.',
      'migration_hold_reclaim labeling narrowed (exact tag / armed grad only); migration_sniper disc without style → discretionary_other.',
      'Migration MC enrich: Jupiter + stale circulating MC in resolveSourceEntryMcUsd; lane enrich writes source+metrics MC; grad watch refresh uses curve/Jupiter.',
      'Disc mix: hard throttle only fast profiles (scalper/MB/reversal); arm-inventory relief ~45%; non-fast size ×0.85; Disc + mix-throttle chips on Expectancy Lift.',
    ],
  },
  {
    version: '1.2.237',
    title: 'Expectancy Lift Layer',
    sections: ['microbots', 'tradecraft', 'learning', 'zion', 'scanners', 'overview'],
    items: [
      'Expectancy Lift card on Bot Performance: mix chips (armed 70% / late-chase ≤5% / Scalper ≤30%), profile expectancy table, family governor board, armed funnel, Chart.js.',
      'Soft family governors (promoted/neutral/down-ranked/restricted) + trade permission score; hard late-chase share ceiling; armed/disc 70/30 mix; one-setup-one-profile lock.',
      'Stronger Mode B / Dip reclaim confirm (touch→reclaim; reject touch-and-fail); MB stamp level_momentum_expansion; PCL partial retune; episode quality weights expectancy + MFE capture.',
      'Scalper attention window 20 + 30% share cap; skip discretionary Scalper when ≥1 Scalper open; expectancy-weighted size 0.7–1.15.',
      'Zion one-liners for expectancy lift; GET /api/expectancy-lift?window=20|50|100.',
    ],
  },
  {
    version: '1.2.236',
    title: 'Mode B funnel fix + watch-origin trade badges',
    sections: ['microbots', 'scanners', 'overview', 'tradecraft', 'knobs'],
    items: [
      'Mode B: offer before minRank, divert to watch only when parked, and admit mid-band through $800k (not instant-entry only).',
      'Funnel diagnostics: Mode B open rate plus offered / armed / watch counters for setup-watch health.',
      'setupWatchFamily stamps + Watch / Mode B / Dip / Grad badges on open and closed trades.',
      'Hard-lock preferred profile on armed watch handoffs (no silent reassignment; skip if that profile is OFF).',
      'Grad armedWatch parity with Scalper Mode B / Dip handoffs.',
    ],
  },
  {
    version: '1.2.235',
    title: 'Dashboard JS stall fix (Smart Mirror alert escapes)',
    sections: ['overview', 'scanners', 'copy', 'knobs'],
    items: [
      'Fix dashboard freeze: Smart Mirror Add-token alert used \\n / \\b inside the HTML template literal, which broke the main script parse.',
      'Mode B tip: remove raw <$150k in data-tip (HTML treated it as a tag).',
    ],
  },
  {
    version: '1.2.234',
    title: 'Mode B cooldown bypass + Scalper mid-band + playbook floors',
    sections: ['microbots', 'scanners', 'copy', 'overview', 'knobs'],
    items: [
      'Armed Mode B / Dip / Grad triggers bypass scanner mint cooldown on handoff; soft skips use short CD while a mint is on an active armed watch. Active watch count uses the full map.',
      'Scalper Mode B mid-band $150k–$800k support reclaim (quick TP); microcaps <$150k stamp Migration / Reversal. Dip Fib overlap resolved by active dip watch — not a hard $500k cut.',
      'TA playbooks + Micro Bot match defaults retuned per lane (MC / holders / max top-10%). Smart Mirror watchlist shows skip hints (anti-rug / MC<$8k); delay UI default 45s; bags still not auto-copied.',
    ],
  },
  {
    version: '1.2.233',
    title: 'Armed-watch soft-pass + Scalper attention + PCL harvest',
    sections: ['microbots', 'scanners', 'tradecraft', 'learning', 'zion', 'overview'],
    items: [
      'Armed setup watches (Scalper Mode B / Dip / Grad) soft-pass Gatekeeper advisories; hard safety still final. Trigger→open stamps entryPath + armedWatch through buy/PCL.',
      'Scalper attention share capped ~35% when WR <45% or Fast Recovery stage ≤1; armed reclaim bypasses the cap. MARL expectancy downrank + Stage 0/1 cadence retune.',
      'PCL/PPP harvest for armed/medium-high reclaim: early partial ~8–10% @ 0.40–0.50, PPP arm ~75% of TP, permission ×1.5, no tiny scratch when MFE ≥10%.',
      'Learning up-weights armed reclaim episodes and down-weights Scalper scratch spam; Zion answers Dip quiet / armed counts / open rate. Watchlist diagnostics strip + /api/setup-watch-diagnostics.',
    ],
  },
  {
    version: '1.2.232',
    title: 'Smart Mirror copies + fight log + watchlist UX',
    sections: ['copy', 'scanners', 'overview', 'microbots'],
    items: [
      'Influencer Mirror: pin tagged wallets in soft-watch (even when Favourites cap is 0), migrate copy delay 15s→45s so slow polls are not skipped as late, and log copy/skip rows on the lane fight log (Smart Money Mirror).',
      'Smart Mirror Watchlist: Copy CA + Jupiter on each of the top 3 tokens, peach/gold Copied badge with time/size when mirrored, force refresh on Watchlist tab + ~60s throttle.',
    ],
  },
  {
    version: '1.2.231',
    title: 'Fast-profile Mode B divert + TA playbook align',
    sections: ['microbots', 'scanners', 'overview', 'knobs'],
    items: [
      'While Scalper Fast Recovery is Stage 0–1, Mode B preferredProfileId stamps Scalper only on true support reclaim (not every ≤$180k name) so Momentum Burst / Reversal can share the strip; recovery still throttles admits, not watchlist admission.',
      'Fast Profile TA playbooks realigned to catalog (Scalper Soft + learning on, MB Soft, Reversal Hard, Migration Soft); one-shot clears drifted overlays. Playbooks do not gate Mode B pickup — Soft/Hard score entries on buy.',
    ],
  },
  {
    version: '1.2.230',
    title: 'Smart Mirror Watchlist top-3 + MC/holders',
    sections: ['copy', 'scanners', 'overview'],
    items: [
      'Smart Mirror Watchlist shows latest 3 tokens per influencer (was 5); UI copy and Bot Info match.',
      'MC / holders enrichment now prioritizes displayed mints, uses a light Dex/Jupiter/GMGN path (no slow on-chain holder walk), and runs in parallel with a reserved time budget so metrics are no longer starved by holdings RPC.',
    ],
  },
  {
    version: '1.2.229',
    title: 'Scalper Mode B support-reclaim priority',
    sections: ['microbots', 'scanners', 'overview'],
    items: [
      'Scalper lane / Mode B watch soft-prefers support reclaim and near multi-TF support (scalp_reclaim_burst DNA); late chase away from support is tightened.',
      'When armed or reclaiming at support, preferredProfileId prefers scalper unless reversal wick or MB volume-expansion dominate; MC ≤$180k mutual exclusion with Dip unchanged.',
    ],
  },
  {
    version: '1.2.228',
    title: 'Smart Mirror Watchlist timeout UX',
    sections: ['copy', 'scanners', 'overview'],
    items: [
      'Smart Mirror Watchlist no longer shows Discover’s “GMGN curated fallback” on AbortError; Refresh uses a 60s timeout and clearer RPC/metrics messaging.',
      'Watchlist build: light-concurrency holdings fetch + 45s deadline so slow utility RPC returns a partial list instead of hanging past the client abort.',
    ],
  },
  {
    version: '1.2.226',
    title: 'Smart Wallets sub-tabs cleanup',
    sections: ['copy', 'overview', 'knobs'],
    items: [
      'Smart Wallets is now five priority sub-tabs: Discover → Nansen.ai → Tracked → Live Trading → Influencer Mirror.',
      'Removed unused Wallet Search, Top Smart Wallets (GMGN quick), Monitor & Discovery standalone card, and Scalper Wallets duplicate table; discovery status lives on Discover.',
    ],
  },
  {
    version: '1.2.225',
    title: 'Influencer Smart Mirror enhancements',
    sections: ['copy', 'scanners', 'risk', 'coaches', 'overview'],
    items: [
      'Add Wallet + defaults strip (Soft Gatekeeper, sizeMult, tags, followSells); Import top 15 (30d PnL, GMGN primary) + Jupiter influencers fail-soft.',
      'Soft Gatekeeper on mirror buys (activity advisory; anti-rug absolute); mirror-sell preferred vs PPP with poor-signs earlier harvest; soft SL overlay on mirrored positions.',
      'Watch-tab Smart Mirror Watchlist: top 10 influencers × 5 tokens, holding/sold/partial, MC/holders, your-hold badge, +N cross-hold, Add token → profile-sized mirror buy.',
      'More Info: Influencer Mirror · {name}; explain influencer_mirror_sell.',
    ],
  },
  {
    version: '1.2.224',
    title: 'Dip watch minors unstarved + Minors/Majors tabs',
    sections: ['scanners', 'overview', 'microbots'],
    items: [
      'Dip watchlist: separate caps (minors ≤16, majors ≤12) so high-MC majors no longer crowd out scanner/memecoin watches; status API interleaves both buckets.',
      'Dip Buyer strip: Minors / Majors tabs (default Minors, localStorage) replace dual checkboxes; per-tab counts; rename Normal → Minors.',
    ],
  },
  {
    version: '1.2.223',
    title: 'Watchlist rename + Dip Majors/Normal filters',
    sections: ['scanners', 'overview', 'microbots'],
    items: [
      'Nav rename: Live Feed -> Watchlist (short label Watch on phones) so the tab matches setup watches.',
      'Dip setup watchlist: dual Majors / Normal checkboxes (both on by default) replace Majors-only; prefs persist in localStorage with legacy migration.',
    ],
  },
  {
    version: '1.2.222',
    title: 'Dashboard Influencer Mirror JS fix',
    sections: ['copy', 'overview', 'knobs'],
    items: [
      'Fix dashboard stall: Influencer Mirror wallet onchange handlers used broken quote escapes inside the HTML template literal, causing a client SyntaxError that froze the UI.',
      'Same escape class as Trade Craft selectTradeCraftTrait — double-backslash so the browser receives valid JS string quotes.',
    ],
  },
  {
    version: '1.2.221',
    title: 'Influencer Mirror + majors GK soft-pass',
    sections: ['copy', 'coaches', 'risk', 'scanners', 'execution'],
    items: [
      'Influencer / Top PnL Smart Mirror (default OFF): tagged watchlist, CSV/GMGN fail-soft, fast SMM buy + optional copy-sell on mirrored positions only; per-wallet learning nudges copyWeight.',
      'Requires smart_money_copy + smart_money_mirror; Jito/turbo prefer with fallback; max concurrent + delay-window spam guard; anti-rug / hard SL absolute.',
      'Majors Dip-watch handoffs soft-pass HMC Gatekeeper activity floors (specialtyFeed/majors stamp); hard safety unchanged.',
    ],
  },
  {
    version: '1.2.220',
    title: 'High-MC majors → Dip watch',
    sections: ['scanners', 'microbots', 'zion', 'execution', 'risk'],
    items: [
      'Majors feed: Jupiter toptraded/organic (no pump filter), circulating MC ≥$100M + liq floor → Dip support-dip watch with longer TTL and majors badge; never Scalper Mode B.',
      'On reclaim soft-prefer Dip Buyer; Steady/Trend/HWR still lane-fight. Zion max MC raised to $2B for $1B+ KOL; quality prefer-MC bias toward $50M.',
      'Hard SL mark-trust: reject FDV-as-MC / unconfirmed dumps so stops do not fire on poisoned marks (ships with majors).',
    ],
  },
  {
    version: '1.2.219',
    title: 'Zion mic freeze + QUEST FDV/MC marks',
    sections: ['zion', 'execution', 'risk', 'scanners'],
    items: [
      'Zion mic: restart backoff, start watchdog, and hard fail after repeated errors so recognition loops no longer freeze the dashboard.',
      'Never promote Dex FDV into circulating MC (QUEST-class MC==FDV); mark reconcile rejects FDV-inflated ratios and skips unsafe MC upscale.',
      'Decimals/supply-aware mark and metrics paths so bad token decimals cannot inflate Live MC / paper PnL.',
    ],
  },
  {
    version: '1.2.218',
    title: 'Entry-style DNA + late-chase + PCL align',
    sections: ['risk', 'tradecraft', 'microbots', 'learning', 'scanners'],
    items: [
      'Per-profile entry-style DNA (primary/allowed/forbidden) scored before HMC soft/MARL; late-chase hard-zeros quality/Mirror/Trend/Dip.',
      'Shared support-reclaim detector unifies Dip (~1.5%) and Scalper Mode B (~1.2%) watch triggers; opens stamp entryStyle + lateChaseAtEntry.',
      'High-q valid styles stretch PCL permission / later PPP arm; Trade Craft + Zion show late-chase mix; badges beside entry source.',
    ],
  },
  {
    version: '1.2.217',
    title: 'Multi-TF S/R + Scalper Mode B watch',
    sections: ['risk', 'tradecraft', 'microbots', 'scanners', 'learning'],
    items: [
      'Real multi-TF OHLCV (5m/15m/30m/1h/4h) + S/R confluence; Mode B immediate only at multi-TF support (≥2 TFs incl. higher TF).',
      'New Scalper-family setup watch (parallel to Dip); PTA soft S/R defaults for Scalper/MB + 30m TF; episode stamps for confluence / watch trigger.',
    ],
  },
  {
    version: '1.2.216',
    title: 'Trade Craft manual + soft craft learning',
    sections: ['tradecraft', 'learning', 'coaches', 'lifecycle'],
    items: [
      'New Bot Info Trade Craft chapter: easy scorecard, deep trait→film manual, trade/learn workflow SVGs, live Combined craft example, operator checklist.',
      'Bot Info polish: sticky chip nav under tabs, higher section scroll-margin, lifecycle 2-col mid breakpoint and less 3D/vertical waste.',
      'Self-Learn soft-aligns Timing/PPP/PCL candidates from Harvest/Exits craft deltas (±4); PPP shadow + ML patch features + ML-led PCL candidates.',
    ],
  },
  {
    version: '1.2.215',
    title: 'Trade Craft Progress script fix',
    sections: ['coaches', 'overview'],
    items: [
      'Fixed Trade Craft Progress trait button onclick string escapes so the dashboard inline script parses again (was a SyntaxError from bad quote escaping).',
      'selectTradeCraftTrait handlers emit correctly escaped quotes inside the template-literal HTML builder.',
    ],
  },
  {
    version: '1.2.214',
    title: 'Dashboard stall / backup storm fix',
    sections: ['backup', 'scanners', 'overview'],
    items: [
      'Critical GitHub backup uploads enforce a 60s min gap so HMC/FPR save storms stop starving the event loop.',
      'Site-backup latest/bundled JSON meta loads cache by mtime to avoid re-parsing multi-MB files on every poll.',
      'Market scanner wake interval follows pollIntervalMs (half, clamped 8-30s) instead of a fixed 5s busy-wake.',
    ],
  },
  {
    version: '1.2.213',
    title: 'Profit-protection learning robustness',
    sections: ['coaches', 'risk', 'learning', 'overview'],
    items: [
      'Denser PPP/PCL learning film: arm timing, near-miss, partial milestones, permission exits, and CF looser/later-arm/skip-partial stamps feed Self-Learn, ML, and Profile RL.',
      'Self-Learn/ML nudge peak-protect arm/giveback + PCL permission/early partial on a denser exit-policy micro path; Profile RL rewards harvest outcomes; MARL soft-ranks by capture/giveback only.',
      'Overview Reset salvages open trades as dashboard_reset episodes before clearing; Trade Craft film shows PPP/PCL/CF columns; Bot Info checklist for harvest learning.',
    ],
  },
  {
    version: '1.2.212',
    title: 'Trade Craft Progress',
    sections: ['coaches', 'risk', 'learning', 'overview'],
    items: [
      'Bot Performance: Trade Craft Progress card — harvest/PCL, hold, profit-taking, exits, TA craft, decision stack scores per bot + Combined.',
      'Rolling 20/50/100 windows with early→late deltas, Chart.js curves, Combined ranking table, and entry→exit trade film.',
      'Episodes stamp PCL process fields (permission exit, scratch blocks, deferred PPP arm, MFE capture ratio, learning delta) for future film.',
    ],
  },
  {
    version: '1.2.211',
    title: 'Lifecycle hero asset slimmed',
    sections: ['lifecycle'],
    items: [
      'Trading Bot Lifecycle hero switched to compressed JPEG (~110KB) for faster Bot Info loads.',
    ],
  },
  {
    version: '1.2.210',
    title: 'Trading Bot Lifecycle guide',
    sections: ['lifecycle', 'overview', 'coaches'],
    items: [
      'New first Bot Info chapter: Trading Bot Lifecycle — signal → enrich → HMC → lanes → MARL/RL → filters → TA → buy → PPP/PCL → learn.',
      'Hybrid visuals: hero PNG + isometric SVG map + stage cards with one continuous $RIVER story and Where to find paths.',
      'Zion documented as a side door; self-learn/ML clarified as post-close coaches (not mid-pipeline vetoes).',
    ],
  },
  {
    version: '1.2.209',
    title: 'Bot Info major-feature guides',
    sections: ['coaches', 'risk', 'microbots', 'learning', 'overview', 'zion'],
    items: [
      'Coaches chapter: detailed HMC Gatekeeper, HMC Setup Classifier, MARL, Profile RL, and PCL-as-exit-coach guides with live examples + Where to find paths.',
      'Risk chapter: Peak Profit Protection and Profit Capture Layer operator manuals (permission windows, PPP retune, partial+runner, anti-scratch).',
      'Overview / Micro Bots / Learning / Zion: short stack pointers (HMC·PCL·PPP, Gold→SMM auto-send, quality stamp / learning reshape).',
    ],
  },
  {
    version: '1.2.208',
    title: 'Profit Capture Layer',
    sections: ['microbots', 'risk', 'learning', 'zion', 'knobs'],
    items: [
      'Additive Profit Capture Layer: short permission windows soften over-early scratch exits; hard SL / anti-rug unchanged.',
      'PPP retuned (fast 60/40, dip-trend/quality 65/45) with min-open / min-profit floor, deferred arm in permission, stronger giveback after partial.',
      'Earlier meaningful partials + runner trail nudge; live/sync exit priority rebalanced; learning boosts MFE capture / partials and penalizes tiny scratch.',
      'Dashboard PCL card (enable + learning strength + family permission overrides), open-trade permission/partial/PPP lines, Zion one-liners.',
    ],
  },
  {
    version: '1.2.207',
    title: 'Running pill pause/resume',
    sections: ['overview', 'modes'],
    items: [
      'Header Pause and Paper buttons removed (desktop + mobile); mode switches stay Live Sim / Live.',
      'Click the Running status pill to pause (confirm) — peach Paused badge with the same Pause peach accent; click Paused to resume (confirm).',
      'Running pill keeps green-dot + play + label and adds a small teal pause icon as the pause affordance.',
    ],
  },
  {
    version: '1.2.206',
    title: 'Zion Gold → Smart Money Mirror auto-send',
    sections: ['zion', 'microbots', 'overview'],
    items: [
      'New Zion toggle: Auto-send Gold to Smart Money (default OFF). Gold = score ≥85, ≥8 KOL, 1h vol ≥$500k (below Platinum).',
      'When ON, Gold offers auto-open on Smart Money Mirror with SMM sizing/exits, synthetic decision, and lane-fight open; OFF stays manual Place Trade.',
      'Platinum → HWR remains exclusive (Platinum never routes to Gold/SMM). Both auto-send toggles work independently.',
    ],
  },
  {
    version: '1.2.205',
    title: 'HMC rebalance for Trend / Dip / Steady',
    sections: ['microbots', 'knobs', 'execution'],
    items: [
      'Classifier maps widen: Trend Rider on dip / migration / slow_quality; Steady Compounder on momentum / dip — soft eligibility stays OFF.',
      'High-confidence narrow bar raised 0.55 → 0.65 so borderline setups use full specialist eligibility.',
      'Gatekeeper Medium: thin 5m volume is advisory for quality / non-fast hints when 1h volume clears the Medium floor (hard safety still blocks).',
      'Lane priorities: Trend Rider 76, Steady Compounder 70; Dip Buyer eases MC / H1 confirm floors on classified or structural dip paths.',
    ],
  },
  {
    version: '1.2.204',
    title: 'Market Scanner enable sticks',
    sections: ['overview', 'microbots', 'alerts'],
    items: [
      'Fix: Market Scanner ON/OFF no longer false-reports OFF when a Smart Bot lane without scanner (e.g. Scalper) is mid-cascade — status, poll, AlphaScan, dip-watch, and specialty feeds use the global toggle.',
      'Live Feed Enable checkbox binds to persisted config.marketScanner.enabled (not transient status), so Save cannot flip the master off after a race.',
      'One-shot restore Market Scanner ON; 60%+ Win Rate pack no longer forces scanner OFF; Scalper-style profiles allowlist ta_market_scanner.',
    ],
  },
  {
    version: '1.2.203',
    title: 'HMC classifier — restore trade volume',
    sections: ['microbots', 'learning', 'overview'],
    items: [
      'Setup Classifier confidence floor raised (0.50); ambiguous / close-second / conf < 0.55 widens eligibility to all specialists while still logging the preferred setup.',
      'Wider eligibility maps (momentum + Reversal; dip + Reversal/Scalper; migration + Scalper/Momentum Burst). MIG_FRESH only when migration context is already present.',
      'Soft eligibility (default ON): preferred lanes score normally; non-preferred still compete with ~−15% (reason hmc_soft_deprioritized) — no hard hmc_not_eligible. Toggle under Classifier Show; hard filter when OFF.',
    ],
  },
  {
    version: '1.2.202',
    title: 'Zion wake-word mic + places reliability',
    sections: ['zion', 'overview'],
    items: [
      'Zion mic: wake-word idle (say “Zion”) → active listen with chime, ≥5s speak floor, ~3s silence auto-send, 10s keep-alive; mic preference persists in localStorage and resumes on widget/tab open; busy clear resumes recognition.',
      'Places: Overpass 429/503 Retry-After + mirror backoff, short in-memory cache, cinema 12→25 km expand, friendlier rate-limit copy + one delayed retry.',
      'Location: high-accuracy refresh when stale before lifestyle asks; no Sunshine Coast-as-device payload; reverse-geocode area label in status (“Location: on · {area}”) and lifestyle replies.',
      'Zion chat emoji feedback buttons use transparent backgrounds with a subtle rounded outline (dark UI), not solid green/teal fills.',
    ],
  },
  {
    version: '1.2.201',
    title: 'Fix blank dashboard — Zion location string SyntaxError',
    sections: ['overview', 'zion', 'alerts'],
    items: [
      'Dashboard inline JS no longer dies on parse: Zion location ack used an unescaped \\n inside the HTML template literal, which became a real newline and SyntaxError’d the entire script (blank/frozen UI).',
      'Charts and closed-trade poll handlers are null-safe when cumulativePnl/winLoss/closed are missing after slim payloads; paper-status live-data toggles guard missing DOM/nodes.',
    ],
  },
  {
    version: '1.2.200',
    title: 'Dashboard unstick — stop poll-path OneDrive probes + fat JSON',
    sections: ['overview', 'alerts', 'backup'],
    items: [
      'Persistence status no longer write-probes DATA_DIR on every /api/status (was syncing .write-probe via OneDrive every 5s). Cached ~30s; probe at most ~2 min.',
      'Fast positions poll returns open rows only; closed trades are slimmed (~field subset) and no longer duplicated on /paper-status. Charts dropped from /api/status; chart series capped.',
      'OneDrive lock retries no longer Atomics.wait on the hot path — busy writes defer to a short background flush. /dashboard is gzip-compressed (~1.6MB → much smaller transfer).',
    ],
  },
  {
    version: '1.2.199',
    title: 'Stop dashboard freezes from OneDrive lock waits + huge logs',
    sections: ['overview', 'alerts', 'backup'],
    items: [
      'Atomic data saves no longer busy-wait up to ~1.4s on OneDrive/AV file locks — short Atomics.wait retries then fall through so /health and the dashboard stay responsive.',
      'app.log rotates automatically above ~32MB (was growing past 700MB and adding disk pressure on the bot folder).',
      'Dashboard polls return the latest 100 closed trades instead of the full ring (~500KB+ payloads every few seconds).',
    ],
  },
  {
    version: '1.2.198',
    title: 'Zion trending attention shows full Jupiter CA links',
    sections: ['zion', 'overview'],
    items: [
      'Trending attention nudges show the full token mint (no ellipsis) with both the ticker and CA as clickable Jupiter token links.',
      'Zion chat bubbles render markdown links ([label](url)) so ambient nudges and replies can open external pages in a new tab.',
    ],
  },
  {
    version: '1.2.197',
    title: 'Overview Reset restores scanner signal flow',
    sections: ['overview', 'scanners'],
    items: [
      'Overview Reset now clears Market Scanner mint cooldowns / feed / in-flight lock and buy-queue backlog (same session suppressors a deploy wiped).',
      'Reset clears wallet-poll 429 pause and resumes the monitor after risk-halt clear so Halt→Reset no longer leaves scanning paused while stats look fresh.',
    ],
  },
  {
    version: '1.2.196',
    title: 'Zion voice, chat UX, and location reliability',
    sections: ['zion', 'overview'],
    items: [
      'Voice: lexicon repairs + fuzzy send/clear/cancel/new-question; final transcripts commit to the box (interim preview only); 3s silence auto-send after finals with a corrector pass.',
      'Composer stays editable while Zion replies (Send disabled only); mic moves to the action row with an iOS-style SVG and stay-on rules (pause while typing reply, off on typing/refresh/2 min idle).',
      'Emoji feedback persists in sessionStorage (selected stays full color; no green pill). Location auto-asks on Zion open; status is Location on/off/asking…; denied flow offers Turn on location + NL on/off. Overpass uses bbox queries, longer timeout, and mirror retries.',
    ],
  },
  {
    version: '1.2.195',
    title: 'Zion lifestyle — weather, food, fitness, nutrition',
    sections: ['zion', 'overview'],
    items: [
      'Locate me on Zion chat (main + widget): browser geolocation cached ~25 min in sessionStorage; chat sends lat/lon + timeZone (Sunshine Coast fallback if denied).',
      'Free-first lifestyle: Open-Meteo weather, OpenStreetMap Overpass places (restaurants/cafes/pizza/takeaway/cinema/gym/futsal), built-in training sessions + Mifflin–St Jeor macros/meal templates — no paid APIs required.',
      'Cinema: nearby theatres listed; live showtimes only acknowledged when ZION_CINEMA_SHOWTIMES_API_KEY is set (never invents times or IG/TikTok virality).',
    ],
  },
  {
    version: '1.2.194',
    title: 'Zion chat emoji feedback + voice input',
    sections: ['zion', 'overview'],
    items: [
      'Learning feedback under Zion replies is now compact emoji reactions (🙂 😐 🙁 😢) with light hover/click animation — same Good / Too technical / Forgot context / Better signals.',
      'Composer stays focused after Send for rapid follow-up questions. Mic toggle before Send: voice dictation (Web Speech API), 3s silence auto-send, and helpers (“send”, “clear”, “cancel”, “new question”). Mic defaults off each page load.',
    ],
  },
  {
    version: '1.2.193',
    title: 'Zion continuous learning',
    sections: ['zion', 'learning', 'overview'],
    items: [
      'Zion LLM chats now include the last ~12 turns plus working memory so he stays on-topic across the thread.',
      'Continuous learning stores (working / long-term / Bot Info growth / personality versions), feedback buttons on chat bubbles, and Personality vN rollback.',
      'Domain crypto/Solana curriculum with live top-coin refresh; ambient BTC/SOL briefs, trending attention nudges, and family weather/time (Sunshine Coast, NZ towns, Sölvesborg).',
    ],
  },
  {
    version: '1.2.192',
    title: 'Lane fight skip reason under MARL',
    sections: ['microbots', 'overview'],
    items: [
      'Lane Fight Log shows a white “skip: …” line under MARL (or at the end of the row) for skipped / no-buy fights — best failed lane, cascade reject, or HMC/classifier block.',
    ],
  },
  {
    version: '1.2.191',
    title: 'Critical settings no longer poison GitHub backup',
    sections: ['backup', 'knobs', 'microbots', 'zion'],
    items: [
      'When config.json already exists but HMC / FPR Group / Dip Recovery / Zion transfers / Trade Caps still match code defaults, boot overlays preferred values from bundled site-backup-latest.json and persists them (seed alone only ran when config was missing).',
      'Upload to GitHub runs the same reconcile first so a defaults-stamped DATA_DIR cannot overwrite a good remote backup. Post-import reconcile re-applies if remote was already poisoned.',
    ],
  },
  {
    version: '1.2.190',
    title: 'HMC Low no longer starves quiet feeds',
    sections: ['microbots', 'knobs', 'execution'],
    items: [
      'Gatekeeper strictness Low keeps soft activity findings advisory (even with Enforce soft blocks ON); hard safety (honeypot / anti-rug / high risk) still always blocks. Medium/High still honor soft-enforce.',
      'Volume Intelligence collapse / fast hard floors are capped to Gatekeeper floors so VI default H1 $1500 (and fast mins ~800/2000) cannot outrank Low (400/1200).',
    ],
  },
  {
    version: '1.2.189',
    title: 'Settings survive fresh deploy volumes',
    sections: ['backup', 'knobs', 'coaches', 'zion', 'microbots'],
    items: [
      'Fresh/wiped DATA_DIR seeds from bundled site-backup-latest.json before defaults persist; first post-empty boot forces GitHub auto-import even if restore copied lastAutoImportSha.',
      'Custom recipe keeps Trade Caps (50/5) across Risk On/Off and bake; FPR/DBR caches invalidate on restore; critical saves queue a best-effort GitHub backup upload.',
    ],
  },
  {
    version: '1.2.188',
    title: 'Zion chat poll for health nudges',
    sections: ['zion', 'alerts'],
    items: [
      'Dashboard lightly polls Zion chat every ~75s (when visible) so supervision health nudges update the unread badge, shake, and reply sound without opening the popup.',
    ],
  },
  {
    version: '1.2.187',
    title: 'Zion health chat nudges + reply sound',
    sections: ['zion', 'alerts', 'coaches', 'overview'],
    items: [
      'Supervision / health / learning-watchdog emails resolve to bondback2026@gmail.com (isaac coerced). Zion posts short Action-needed / All-clear chat nudges without opening the popup — shake + unread badge until you read.',
      'Rate-limited chat nudges (problem + recommended fix). Soft unique Zion chat reply sound (Config → Notifications toggle; quieter than trade chimes).',
    ],
  },
  {
    version: '1.2.186',
    title: 'Closed Trades ring 500 + Profitable timeframe',
    sections: ['overview', 'execution', 'alerts'],
    items: [
      'Closed Trades durable ring raised from 200 → 500 rows (memory + paperBalance.json). No time TTL — oldest still rotate out when over cap.',
      'UI no longer truncates to newest 40 groups. Profitable / Losing filters show all matching closes in the selected Overview timeframe (Now / 1h / 24h / 7d / 30d / All).',
    ],
  },
  {
    version: '1.2.185',
    title: 'Notify email stuck on isaac — fixed',
    sections: ['alerts', 'backup', 'overview'],
    items: [
      'Config → Notifications Email no longer reverts to isaacpascua87@gmail.com: boot/restore coerce + save path force bondback2026@gmail.com for that legacy address only; custom emails untouched.',
      'Stale NOTIFY_EMAIL=isaac… env is ignored; site-backup-latest.json patched so GitHub auto-import cannot reintroduce isaac.',
    ],
  },
  {
    version: '1.2.184',
    title: 'HMC Setup Classifier (Phase 2)',
    sections: ['coaches', 'learning', 'execution', 'overview', 'microbots'],
    items: [
      'Setup Classifier (toggleable, default OFF): after Gatekeeper allow, classifies momentum / dip / migration / slow_quality and restricts eligible specialist lanes; MARL ranks only that subset.',
      'Unknown setups can trade (default ON) keeps all specialists eligible; OFF blocks unknown/low-confidence entries. Agent Decision Log source hmc_classifier; lane fight + Zion show setup/eligibility.',
      'Independent Enable Classifier control under Micro Bots (same nesting as Gatekeeper). No TP/SL mutation; Paper / Live Sim / Live share path.',
    ],
  },
  {
    version: '1.2.183',
    title: 'HMC Gatekeeper (Phase 1)',
    sections: ['coaches', 'learning', 'execution', 'overview', 'microbots'],
    items: [
      'Hierarchical Coordination Gatekeeper: allow/block before lane fight (volume, liquidity, safety, collapsed volume, low-MC congestion, freshness). Hard safety never fails open; soft blocks enforceable. Default ON · medium.',
      'Agent Decision Log source hmc_gatekeeper; lane fight rows show HMC gate summary; Zion comments when gate present. Micro Bots controls for enable, strictness, soft-block enforce, volume floors, debug.',
      'Shared Paper / Live Sim / Live path; brief mint cache; classifier stubs reserved for later phases. No TP/SL mutation.',
    ],
  },
  {
    version: '1.2.182',
    title: 'Stop settings auto-reset',
    sections: ['risk', 'knobs', 'microbots', 'overview'],
    items: [
      'Risk On/Off no longer wipes custom strategy modules — knobs still update; synced recipe mode keeps lean re-sync. Boot bake preserves custom toggles.',
      'Fast Profiles Recovery: ignore saves until hydrated; Group ON auto-enables all four profiles if all were off; logs Group off.',
      'Dip Buyer Recovery Force stage shows None (auto); re-enable keeps the persisted stage instead of resetting to S0.',
    ],
  },
  {
    version: '1.2.181',
    title: 'Dip Buyer Recovery open-starvation relief',
    sections: ['microbots', 'execution', 'overview'],
    items: [
      'Dip Buyer Recovery Stage 0 volume floors softened to $2.5k (5m) / $12k (1h); frequency, concurrency, collapsed-volume, and support+Fib gates unchanged. Stages 1–3 unchanged.',
      'DBR and Fast Profiles Recovery entry counters now tick only after a successful fill (not on gate pass), so failed buys no longer start cooldowns.',
      'Monitor passes nearSupport / nearKeyFib into DBR entry gates; last DBR skip reason shown on the Bot Performance card and Entries path hint.',
    ],
  },
  {
    version: '1.2.180',
    title: 'Dip Buyer Recovery Stages',
    sections: ['microbots', 'learning', 'execution', 'overview'],
    items: [
      'New Dip Buyer–only Recovery Stages 0–4 (parallel to Fast Profiles Recovery): frequency → size → concurrency → Peak Protect arm/giveback, with minute gaps and 5m/1h volume floors — no scalper TP clamps.',
      'Readiness includes bounce follow-through from episode MFE / entry·exit quality / giveback; auto-taper promotes/demotes ±1 stage. Defaults: enabled, Stage 0, auto-taper on.',
      'Wired into entry gates/size, Peak Protect, RL Lead block / Hybrid cap, Learning Mode fairness block, TA support+Fib quality, collapsed-volume soft-skip; Bot Performance card + optional R0–R3 badge chip.',
    ],
  },
  {
    version: '1.2.179',
    title: 'Overview Now + Live wallet indicator',
    sections: ['overview', 'modes'],
    items: [
      'Overview timeframe row: Now (first) → 1h → 24h → 7d → 30d → All. Now shows the live session on screen (open + closed) without historical import; Import trades is disabled in Now. Default for new sessions is Now (saved prefs kept).',
      'Real Live hides the timeframe pills; Import live wallet + Disconnect remain. Until a wallet is connected, session stats stay zeroed — no Paper/Sim bleed. Connected shows a green pill + truncated address; disconnected shows red.',
      'Paper and Live Sim keep full timeframe controls including Now.',
    ],
  },
  {
    version: '1.2.178',
    title: 'Closed Trades unified summary rows',
    sections: ['overview', 'execution'],
    items: [
      'Closed Trades: removed the compact mini PnL under the token name (v1.2.177) — that was a mistake.',
      'Every closed trade now uses the same rich summary as partial-exit parents: token, Entry SOL, Total ±SOL (±%) · $USD, Exit reason, Held time — green + / red − styling matched.',
      'DETAILS button, “N partial exit(s)”, and “tap Details…” appear only when a trade has real partial exits; full TP/SL single exits stay clean.',
    ],
  },
  {
    version: '1.2.177',
    title: 'Closed Trades token mini PnL',
    sections: ['overview', 'execution'],
    items: [
      'Closed Trades show compact green/red PnL under the token name on every row (including grouped parents): SOL on line 1, USD with % on line 2 — easier on mobile when the PnL column is off-screen.',
      'Open Positions 5m/1h vol stacking and column widths from 1.2.176 confirmed so decay chips stay out of PnL.',
    ],
  },
  {
    version: '1.2.176',
    title: 'VI false-decay hotfix + Positions UI',
    sections: ['overview', 'execution', 'microbots'],
    items: [
      'Fixed false “decaying” from H1/12 pace + sub-minute M5 ring polls that over-triggered soft exit urgency after v1.2.175; soft exit urgency defaults OFF (sticky 175 settings migrated once); absolute collapse still mildly tightens Peak Protect.',
      'Overview maxDD floored at 0 equity trough (caps absurd 1000%+ readings from import overlays / negative cumulative equity).',
      'Open Positions 5m/1h vol column stacks decay/divergence chips under the numbers and widens so chips no longer spill into PnL.',
      'Closed Trades show a compact green/red PnL under the token name (SOL, then USD with %) for mobile glanceability; existing PnL column unchanged.',
    ],
  },
  {
    version: '1.2.175',
    title: 'Volume Intelligence layer',
    sections: ['microbots', 'execution', 'learning'],
    items: [
      'Additive Volume Intelligence: strength score, decay (expanding/stable/decaying/collapsed), and price-volume divergence (ZigZag reuse) folded into auto-score, fast soft skips, Peak Protect tighten, and soft exit urgency.',
      'Open Positions show 5m · 1h volume with optional decay / divergence chips; learning episodes stamp volume state at entry/exit.',
      'GET/POST /api/config/volume-intelligence — fail-soft, no forced trades, Paper / Live Sim / Live shared paths.',
    ],
  },
  {
    version: '1.2.174',
    title: 'Fast Recovery card header alignment',
    sections: ['microbots'],
    items: [
      'Fast Profiles Recovery cards keep the stage badge on one line with the bot name (fixes Momentum Burst wrapping on desktop).',
    ],
  },
  {
    version: '1.2.173',
    title: 'Profile routing tab cleanup',
    sections: ['microbots'],
    items: [
      'Profiles is the default Profile routing tab; Smart Bot / Multi-profile toggles sit under the bot cards. Scoring shows only auto-score; Learning shows Live Mode Learning plus MARL / Profile RL / accelerators / enhancements.',
    ],
  },
  {
    version: '1.2.172',
    title: 'Bot Performance Trend profile picker',
    sections: ['microbots'],
    items: [
      'Bot Performance Trend chart adds a Bot dropdown (all micro-bots except Default) so you can view rolling WR/PnL for any profile, not only Scalper.',
    ],
  },
  {
    version: '1.2.171',
    title: 'Bot performance email skips Default',
    sections: ['alerts', 'microbots'],
    items: [
      'Bot performance digest email and snapshot data exclude the unused Default profile so rankings and totals only cover real micro-bots.',
    ],
  },
  {
    version: '1.2.170',
    title: 'Micro Bots Profile routing tabs',
    sections: ['microbots'],
    items: [
      'Micro Bots header revamped into one Profile routing card with Scoring / Profiles / Learning tabs — Automatic Scoring first; Smart Bot + Trade Profiles and Live Mode Learning below; mobile-friendly; all setting IDs preserved.',
    ],
  },
  {
    version: '1.2.169',
    title: 'Recovery badges + control field overlap fix',
    sections: ['microbots', 'overview', 'knobs'],
    items: [
      'Fixed overlapping labels on Fast Profiles Recovery controls (Cooldown typo, ctl-sm overflow) and contained long field labels dashboard-wide.',
      'Minimal R0–R3 recovery-stage hints (red/peach) on profile chips, trade badges, Micro Bot cards, overview table, and Bot Performance.',
    ],
  },
  {
    version: '1.2.168',
    title: 'Dashboard Fix + Live Overlay Sync',
    sections: ['overview', 'microbots', 'execution'],
    items: [
      'Fixed dashboard stall: Fast Profiles Recovery button onclick strings were under-escaped inside the HTML template, so the entire client script failed to parse.',
      'Live wallet session overlay auto-refreshes on open/close and status when connected — Overview drops stale imported opens and merges new closes without re-clicking Import.',
      'System live closes append to on-disk per-wallet history immediately; Import live wallet remains the full balance + opens + closed reconcile path.',
    ],
  },
  {
    version: '1.2.167',
    title: 'Import Overlay, Live Wallet & Live Mode Learning',
    sections: ['overview', 'microbots', 'learning', 'execution'],
    items: [
      'Import trades now writes open + closed into a session overlay so Overview Available / Positions / Open / Realized / Daily match the imported window; sounds muted during import; import status auto-hides after 10s.',
      'Live mode: hide Import trades; Import live wallet loads on-chain equity/available + bot-recorded live opens/closes (persisted per wallet); Disconnect clears Live UI while keeping history; first Live visit stays zeroed until import.',
      'Live Mode Learning toggle (default OFF) — Live Sim keeps learning; Live closes skip episodes unless toggled on. Mobile Total Equity keeps timer/date/Reset top-right.',
    ],
  },
  {
    version: '1.2.166',
    title: 'Dark Email Theme with Peach Accents',
    sections: ['alerts', 'zion', 'overview', 'backup'],
    items: [
      'Profit instant/cluster emails restyled to a shared dark theme with Zion peach accents.',
      'Bot performance, Zion trade offers / improvements / supervision, system alerts, and learning watchdog emails use the same dark template for consistency.',
    ],
  },
  {
    version: '1.2.165',
    title: 'Zion Main Wallet Address Update',
    sections: ['zion', 'knobs', 'overview'],
    items: [
      'Zion Main / primary trading wallet seed updated to the new live address for balances, history, and whitelist transfers.',
      'Persisted settings and Zion chat/archives auto-migrate off the retired Main pubkey so Zion no longer references it.',
    ],
  },
  {
    version: '1.2.164',
    title: 'Fast Profiles Recovery Stages + Scalper Trend',
    sections: ['microbots', 'learning', 'coaches', 'overview'],
    items: [
      'Fast Profiles Recovery Stages 0–4 for Scalper, Reversal Scalper, Momentum Burst, and Migration Sniper — auto taper frequency→size→concurrency→exits with readiness gates.',
      'Scalper win-rate trend analysis + Chart.js card (10/20/50 windows); Declining/Critical recommends Recovery. Visualisation only.',
      'Dashboard Recovery Stages panel with readiness breakdown, promote/demote gates, and manual stage lock/override.',
    ],
  },
  {
    version: '1.2.163',
    title: 'Zion Whitelist Wallet Transfers',
    sections: ['zion', 'alerts', 'knobs', 'overview'],
    items: [
      'Zion chat can report live balances (SOL + USD), last 5/10/20 txs, SOL price, and transfer totals for Main / Savings / Coinspot aliases.',
      'Whitelist-only SOL sends from the live trading keypair: Yes/No confirm, then password (3 tries); Paper/Live Sim dry-run only.',
      'Config → Zion Transfers: enable toggle, caps, cooldown, and seeded wallets (Coinspot is the only external destination).',
    ],
  },
  {
    version: '1.2.162',
    title: 'Multi-Provider Market-Data Failover',
    sections: ['scanners', 'execution', 'alerts', 'overview', 'zion'],
    items: [
      'Open-trade marks resolve Jupiter → DexScreener → on-chain bonding curve → last good, with failover logs and no Jupiter stampede.',
      'OHLCV uses GeckoTerminal then Dex sparse snapshot candles (no Birdeye); discovery prefers GMGN then Dex when healthy.',
      'Scalper / Migration soft-fail thin candles; Health Watch shows provider cooldowns plus active mark failover source (not RPC/stall).',
    ],
  },
  {
    version: '1.2.161',
    title: 'External Market-Data API Resilience',
    sections: ['scanners', 'alerts', 'overview', 'zion'],
    items: [
      'GMGN 403/401 enter provider cooldown (no aggressive retries); 404 paths are quarantined with concise logs instead of Cloudflare body spam.',
      'GeckoTerminal 429s use exponential cooldown, in-flight OHLCV dedupe, and stale cache reuse so enrichment keeps moving.',
      'Pump.fun coin 404s mark the mint unavailable briefly; Health Watch distinguishes external market-data degradation from RPC/poll stalls.',
    ],
  },
  {
    version: '1.2.160',
    title: 'Configurable Profit Emails',
    sections: ['alerts', 'overview', 'knobs'],
    items: [
      'Profitable-close emails support Instant, Cluster, or Instant + Cluster modes with 1h–24h cluster intervals.',
      'Config → Notifications: set profit email mode, cluster interval, and recipient (default bondback2026@gmail.com).',
      'Paper / Live Sim / Live are labelled clearly in instant and clustered profit emails.',
    ],
  },
  {
    version: '1.2.159',
    title: 'DexScreener + Jupiter Mark Resilience',
    sections: ['execution', 'alerts', 'overview', 'zion'],
    items: [
      'DexScreener 429s enter a shared cooldown with backoff, in-flight dedupe, and cached snapshots — no more retry storms or Cloudflare body spam.',
      'Open-trade marks fall back Dex → Jupiter Tokens → quiet Jupiter quote → last good; monitor mark refresh has a hard timeout so wallet polls cannot hang.',
      'Fixed false “poll stalled” health warning (was treating wallet count as a timestamp); Dex cooldown now shows as market-data degraded Watch instead.',
    ],
  },
  {
    version: '1.2.158',
    title: 'Dashboard Script Fix (Agent Decision Log)',
    sections: ['overview', 'coaches', 'microbots'],
    items: [
      'Fix dashboard stall: Agent Decision Log row onclick used a single-escaped quote inside the HTML template literal, breaking the browser script after that line.',
      'Hard-refresh the dashboard after deploy so the repaired script loads.',
    ],
  },
  {
    version: '1.2.157',
    title: 'Agent Decision Log',
    sections: ['coaches', 'learning', 'zion', 'overview', 'microbots'],
    items: [
      'New Agent Decision Log on Bot Performance: MARL, Profile RL, accelerators, TA, ML, Peak Protect tips, and sparse Zion commentary — separate from the lane fight execution log.',
      'Filters for agent, decision type, applied vs observation-only, profile, and time range. Rate-limited + deduped; logging only (no trade/coach mutations).',
      'API: GET /api/agent-decisions. Fight log stays on Overview / Micro Bots as the execution/conflict feed; ADL is the reasoning/advice feed.',
    ],
  },
  {
    version: '1.2.156',
    title: 'Automated System Health Checks',
    sections: ['zion', 'alerts', 'overview', 'learning'],
    items: [
      'Automated system health checks cover RPC, trading, learning, and risk via a collector plus Zion supervision — recommendations only, no auto-mutations.',
      'Adaptive cadence 15m / 10m / 5m (Healthy / Watch / Action), sustained-only Action escalation, and rate-limited Action emails.',
      'Dashboard, Zion, and APIs expose status: GET /api/zion/supervision and alias GET /api/health/system.',
    ],
  },
  {
    version: '1.2.155',
    title: 'Learning Enhancements — Additive Soft Layer',
    sections: ['microbots', 'learning', 'coaches'],
    items: [
      'Learning Enhancements (Micro Bots master toggle, default OFF): continuous scheduler (~2 min), episode quality weighting, dual-objective Profile RL reward shaping, controlled exploration (8%), and learning health watchdog.',
      'Scheduler runs soft paths only — replay/CF hints, TA nudges, Profile RL readiness refresh — never Level upgrades or hard self-learn mutations (those stay on trade-close).',
      'APIs: GET/POST /api/config/learning-enhancements, GET /api/learning-enhancements/status; diagnostics and Zion plain-language integration.',
    ],
  },
  {
    version: '1.2.154',
    title: 'Zion Chat Faster + Natural Dad Tone',
    sections: ['zion', 'alerts'],
    items: [
      'Zion chat is snappier: slim cached context pack, 7s provider timeouts, Gemini+Groq race (first win), faster flash/8B models first, capped output tokens.',
      'Dad addressing is occasional and natural — drops robotic ", Dad" tags; still knows Isaac is Dad without saying it every sentence.',
    ],
  },
  {
    version: '1.2.153',
    title: 'Bot Info — Coaches & Learning Stack',
    sections: ['coaches', 'learning', 'microbots', 'overview'],
    items: [
      'New Bot Info chapter Coaches & Stack: episodes, self-learn, ML, Profile TA, Profile RL, MARL, accelerators, Peak Protect, Learning Mode — additive priority and isolation.',
      'Documents close/entry learning paths, why learning can look idle (defaults OFF, episode floors), and an activation checklist.',
      'Learning & ML and Micro Bots chapters point to the new stack guide.',
    ],
  },
  {
    version: '1.2.152',
    title: 'Profile RL Readiness Auto-Mode',
    sections: ['microbots', 'learning', 'zion'],
    items: [
      'Per-profile readiness score (0–100) from sample, reward trend, stability, baseline outperformance, and diversity — replaces trade-count-only auto-promote.',
      'Agents auto-promote Shadow→Hybrid→Lead only when readiness thresholds and profile difficulty floors are met; demote on instability or performance drop. Lock checkbox skips auto-adjust.',
      'Dashboard Profile RL shows readiness/100, sample n, and lock per lane; Zion and diagnostics include readiness + mode in plain language.',
    ],
  },
  {
    version: '1.2.151',
    title: 'Zion Personality + Supervision',
    sections: ['zion', 'alerts', 'microbots'],
    items: [
      'Zion family memory: durable household identity (Dad/Mum, Sunshine Coast household, faith context) with memory score in chat context — no invented facts.',
      'Personality-aware chat: address Isaac as Dad, optional scripture cues (~15%), curated psalms on fitting intents; fight-log comments capped rare.',
      'System supervision scheduler (~2.5 min): Normal / Watch / Action needed; rate-limited email alerts on Action needed; toggles on Zion tab.',
    ],
  },
  {
    version: '1.2.150',
    title: 'Profile RL Polish — Wallet Sizing, Mode UI, Zion',
    sections: ['microbots', 'learning', 'execution'],
    items: [
      'Wallet-copy and migration-priority buys now apply the same soft MARL and Profile RL size multipliers as scanner entries — Paper, Live Sim, and Live stay consistent.',
      'Micro Bots → Profile RL: per-profile shadow/hybrid/lead mode selector wired to /api/config/profile-rl; global enable and strength unchanged.',
      'Zion chat context enriched with Profile RL, Learning Accelerators (replay/counterfactual/teacher-student), and Profile TA learned summaries — concise plain language only.',
    ],
  },
  {
    version: '1.2.149',
    title: 'Profile RL Agents + Learning Accelerators',
    sections: ['microbots', 'learning', 'knobs'],
    items: [
      'Profile RL Agents: per-lane soft policy (setup-worth, confidence/size, TA sensitivity, exit-hint aggressiveness) in shadow/hybrid/lead — PPO-style updates with policy history and rollback. Default OFF.',
      'Learning Accelerators: experience replay batches, counterfactual peak/PPP/TP-SL what-ifs on episodes, and teacher→student soft TA weight transfer with auto-rollback if student worsens.',
      'Micro Bots cards for Profile RL and Learning Accelerators; APIs and diagnostics/Zion plain language. Never overwrites TP/SL, Peak Protect, or self-learn hard overrides.',
    ],
  },
  {
    version: '1.2.148',
    title: 'Profile TA Full Indicators + Weight Learning',
    sections: ['microbots', 'learning', 'scanners', 'knobs'],
    items: [
      'Profile TA playbooks now score MACD 12/26/9, Bollinger 20/2, ZigZag structure, and RSI/volume divergence alongside HA, Fib/S-R, and whale tools.',
      'Closed trades stamp which TA tools passed at entry plus MACD/ZigZag/div snapshots — learning correlates per-tool weights (±0.05, max 3/cycle) and divergence/hist sensitivity.',
      'Micro Bots → Profile TA Playbooks shows learned tool weights, div/hist multipliers, and Rollback last learned; auto-rollback if a nudge underperforms.',
    ],
  },
  {
    version: '1.2.147',
    title: 'Overview Trade Import + Live Wallet Gate',
    sections: ['overview', 'execution', 'modes'],
    items: [
      'Overview timeframe row: Import trades loads open/closed for 1h/24h/7d/30d (All capped at 1000) into the session — stats refresh; Overview Reset clears.',
      'Live mode only: Import live wallet scans the env trading wallet for on-chain swap history. Paper / Live Sim rows never appear in Live.',
      'Live trading hard-gated: bots cannot fire until a real wallet key is loaded and the wallet holds the min SOL balance.',
    ],
  },
  {
    version: '1.2.146',
    title: 'Overview Stats Flicker Fix',
    sections: ['overview'],
    items: [
      'Overview Win Rate / Max DD / Trades / Status PF stay on the selected time window across status polls — no more flashing lifetime totals then windowed values.',
      'Windowed stats refresh is throttled; last painted values hold until the next overview-stats fetch completes.',
    ],
  },
  {
    version: '1.2.145',
    title: 'Profile TA Playbooks',
    sections: ['microbots', 'learning', 'scanners', 'knobs'],
    items: [
      'Each micro-bot now has an Off / Soft / Hard TA playbook (Heikin Ashi, Fib/S-R, RSI/EMA/VWAP, patterns, optional whale) with min confluence and unique defaults.',
      'Soft never hard-blocks; Hard can block below score. Learning may nudge playbook weights only — never TP/SL. Global Require TA stays the scanner master.',
      'Tune under Micro Bots → Profile TA Playbooks. Decisions show in plain language on the lane fight log.',
    ],
  },
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
