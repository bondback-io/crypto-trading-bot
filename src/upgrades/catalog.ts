/**
 * Upgrade packs rebuilt on the 1.2.21 core. All start OFF.
 * Toggle in the Upgrades tab, then Save & reboot.
 */

export type UpgradeCategory =
  | 'watchlist'
  | 'trading'
  | 'zion'
  | 'learning'
  | 'bot_learning'
  | 'rpc'
  | 'cosmetics'
  | 'infra';

export type UpgradeStatus = 'ready' | 'pending';

export interface UpgradePackMeta {
  id: string;
  title: string;
  sinceVersion: string;
  summary: string;
  category: UpgradeCategory;
  status: UpgradeStatus;
  /** RPC lane maps are mutually exclusive */
  laneMap?: boolean;
}

export const UPGRADE_CATEGORIES: readonly {
  id: UpgradeCategory;
  label: string;
  blurb: string;
}[] = [
  {
    id: 'watchlist',
    label: 'Watchlist',
    blurb: 'Live Feed → Watchlist tab, majors parks, influencer mirror.',
  },
  {
    id: 'trading',
    label: 'Trading',
    blurb: 'Entry DNA, admission, MC bands, watch/arm ownership, load-mode services.',
  },
  {
    id: 'zion',
    label: 'Zion',
    blurb: 'Platinum tier / HWR handoff and fight-log extras.',
  },
  {
    id: 'learning',
    label: 'Learning',
    blurb: 'Trade Craft UI and soft craft learning.',
  },
  {
    id: 'bot_learning',
    label: 'Bot Learning',
    blurb:
      '1.2.421 self-learn stack: full episode film, Learning Mode, Live-Mode film, MARL/RL/accelerator settings, enhancements scheduler.',
  },
  {
    id: 'rpc',
    label: 'RPC',
    blurb: 'High risk. At most one lane map at a time. Containment can stack.',
  },
  {
    id: 'cosmetics',
    label: 'Dashboard cosmetics',
    blurb: 'Names, layout, graphics, and motion only — not trading logic.',
  },
  {
    id: 'infra',
    label: 'Infra',
    blurb: 'Backup hardening and quieter Render logs.',
  },
] as const;

export const RPC_LANE_MAP_IDS = [
  'rpc_classic_three_lane',
  'rpc_exclusive_keys',
  'rpc_load_mode_inventory',
  'rpc_four_lane',
] as const;

export const UPGRADE_PACKS: readonly UpgradePackMeta[] = [
  {
    id: 'watchlist_tab',
    title: 'Watch List tab',
    sinceVersion: '1.2.223',
    summary:
      'Renames Live Feed → Watchlist (short Watch) and shows Dip / Scalper / Grad setup-watch sub-nav.',
    category: 'watchlist',
    status: 'ready',
  },
  {
    id: 'majors_dip_watch',
    title: 'High-MC majors → Dip watch',
    sinceVersion: '1.2.220',
    summary:
      'Jupiter-style high-MC names can enter Dip support-dip parks (MC ≥ $100M). Does not rename the tab.',
    category: 'watchlist',
    status: 'ready',
  },
  {
    id: 'influencer_mirror',
    title: 'Influencer Smart Mirror',
    sinceVersion: '1.2.221',
    summary:
      'Tagged influencer watchlist service (default off until you also enable copy/mirror modules).',
    category: 'watchlist',
    status: 'ready',
  },
  {
    id: 'scalper_mode_b',
    title: 'Scalper Mode B + multi-TF S/R',
    sinceVersion: '1.2.217',
    summary:
      'Mode B support-reclaim watch: near-support scalper parks prefer reclaim over late chase.',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'steady_hwr_majors',
    title: 'Steady / HWR majors parks',
    sinceVersion: '1.2.259',
    summary:
      'Steady Compounder and High Win-Rate may keep aged high-MC parks instead of hard-skipping on age.',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'expectancy_entry_skill',
    title: 'Expectancy + Entry Skill',
    sinceVersion: '1.2.266',
    summary:
      'Armed watches soft-pass unknown MC; zero-MFE pattern skip eases on armed_trigger.',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'hybrid_admission',
    title: 'Hybrid admission modes',
    sinceVersion: '1.2.392',
    summary:
      'Park unarmed opens; fast-arm when price is near the bot’s TA level (Hybrid default).',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'microbot_mc_bands',
    title: 'Micro Bot live MC bands',
    sinceVersion: '1.2.385',
    summary:
      'Min/Max MC on a Micro Bot card is the admit band for watch/arm when set.',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'watch_arm_ownership',
    title: 'Watch / arm ownership',
    sinceVersion: '1.2.381',
    summary:
      'Owned Dip watches expire after 20m if they never arm/trigger (unless RPC weather paused).',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'system_load_mode',
    title: 'System Load Mode (services only)',
    sinceVersion: '1.2.421',
    summary:
      'Basic / Premium / Full extra-service gates. Does not remap RPC keys.',
    category: 'trading',
    status: 'ready',
  },
  {
    id: 'zion_platinum',
    title: 'Zion Platinum + HWR auto-handoff',
    sinceVersion: '1.2.22',
    summary:
      'Raises Zion max MC to $2B and records HWR handoff eligibility on large KOL names.',
    category: 'zion',
    status: 'ready',
  },
  {
    id: 'zion_fight_log',
    title: 'Zion fight log + KOL extras',
    sinceVersion: '1.2.22',
    summary: 'Persists a compact lane-fight ring for Zion/KOL vs other profiles.',
    category: 'zion',
    status: 'ready',
  },
  {
    id: 'trade_craft_learning',
    title: 'Trade Craft + soft craft learning',
    sinceVersion: '1.2.216',
    summary:
      'Shows Trade Craft scorecard on Micro Bots and allows soft Timing/PPP nudges.',
    category: 'learning',
    status: 'ready',
  },
  {
    id: 'bot_learning_421',
    title: '1.2.421 Bot Learning stack',
    sinceVersion: '1.2.421',
    summary:
      'Full 400-episode film, Live Mode / dashboard-reset episode toggles, Learning Mode (stricter/middle/looser), MARL + Profile RL + accelerator settings, quality-weighted self-learn, ML auto-advance, and the enhancements scheduler (replay/quality/dual-reward/explore/watchdog). Default off until Save & reboot.',
    category: 'bot_learning',
    status: 'ready',
  },
  {
    id: 'rpc_classic_three_lane',
    title: 'Classic three-lane RPC',
    sinceVersion: '1.2.64',
    summary:
      'Critical Helius, Scanners Alchemy, Utility public. Emergency RPC_URL. Off by default.',
    category: 'rpc',
    status: 'ready',
    laneMap: true,
  },
  {
    id: 'rpc_exclusive_keys',
    title: 'Exclusive 10-key RPC map',
    sinceVersion: '1.2.407',
    summary:
      'Distinct Alchemy/Helius keys per major service when set; unused slots skipped. Failover publics only.',
    category: 'rpc',
    status: 'ready',
    laneMap: true,
  },
  {
    id: 'rpc_load_mode_inventory',
    title: 'Load-mode RPC inventory',
    sinceVersion: '1.2.421',
    summary:
      'Trading BACKUP, Scanner BACKUP2, Watcher Helius. Emergency BACKUP3 idle until failover.',
    category: 'rpc',
    status: 'ready',
    laneMap: true,
  },
  {
    id: 'rpc_four_lane',
    title: '4-Lane RPC',
    sinceVersion: '1.2.423',
    summary:
      'Trading BACKUP, Scanner HELIUS_BACKUP, Data BACKUP2, Utility BACKUP3. Emergency publicnode / RPC_URL idle until failover.',
    category: 'rpc',
    status: 'ready',
    laneMap: true,
  },
  {
    id: 'rpc_containment_spike',
    title: 'RPC containment + spike inspector',
    sinceVersion: '1.2.378',
    summary:
      'Skips idle emergency probes and sheds duplicate health checks while preferred lanes are hot.',
    category: 'rpc',
    status: 'ready',
  },
  {
    id: 'dashboard_cosmetics',
    title: 'Dashboard cosmetics',
    sinceVersion: '1.2.44',
    summary:
      'Peach warning buttons, session chip in the header, Settings cog order (Backtester up, Logs off cog), hide Trades nav, profile-chip collapse on mobile, Zion/Bots tab polish.',
    category: 'cosmetics',
    status: 'ready',
  },
  {
    id: 'github_backup_hardening',
    title: 'GitHub backup hardening',
    sinceVersion: '1.2.214',
    summary:
      'Keep auto-import off; 60s minimum gap between scheduled GitHub uploads.',
    category: 'infra',
    status: 'ready',
  },
  {
    id: 'render_rpc_quiet_logs',
    title: 'Quiet soft RPC logs',
    sinceVersion: '1.2.402',
    summary:
      'Soft 429/403 RPC lines log as warn/stdout instead of error. Exit/send stays loud.',
    category: 'infra',
    status: 'ready',
  },
] as const;

export type UpgradePackId = (typeof UPGRADE_PACKS)[number]['id'];

const PACK_BY_ID = new Map(UPGRADE_PACKS.map((p) => [p.id, p]));

export function getUpgradePack(id: string): UpgradePackMeta | undefined {
  return PACK_BY_ID.get(id);
}

export function isReadyUpgradeId(id: string): boolean {
  return PACK_BY_ID.get(id)?.status === 'ready';
}

export function isRpcLaneMapId(id: string): boolean {
  return (RPC_LANE_MAP_IDS as readonly string[]).includes(id);
}
