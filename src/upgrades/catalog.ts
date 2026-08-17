/**
 * Major upgrades added after 1.2.21. Catalog only — packs stay OFF until
 * rebuilt as isolated modules and toggled in the Upgrades tab.
 */

export type UpgradeRisk = 'product' | 'rpc' | 'infra';
export type UpgradeStatus = 'ready' | 'pending';

export interface UpgradePackMeta {
  id: string;
  title: string;
  sinceVersion: string;
  summary: string;
  risk: UpgradeRisk;
  status: UpgradeStatus;
}

export const UPGRADE_PACKS: readonly UpgradePackMeta[] = [
  {
    id: 'zion_platinum',
    title: 'Zion Platinum + HWR auto-handoff',
    sinceVersion: '1.2.22',
    summary: 'Platinum Zion tier with optional auto-handoff to High Win-Rate.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'influencer_mirror',
    title: 'Influencer Smart Mirror',
    sinceVersion: '1.2.221',
    summary: 'Tagged influencer watchlist, CSV/GMGN import, mirror buys/sells, Smart Mirror Watchlist.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'majors_dip_watch',
    title: 'High-MC majors → Dip watch',
    sinceVersion: '1.2.220',
    summary: 'Jupiter majors feed into Dip support-dip, Minors/Majors tabs, Watchlist rename.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'scalper_mode_b',
    title: 'Scalper Mode B + multi-TF S/R',
    sinceVersion: '1.2.217',
    summary: 'Multi-timeframe support/resistance, Mode B watch, support-reclaim priority.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'trade_craft_learning',
    title: 'Trade Craft + soft craft learning',
    sinceVersion: '1.2.216',
    summary: 'Trade Craft chapter, trait scorecard, self-learn Timing/PPP/PCL alignment.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'steady_hwr_majors',
    title: 'Steady / HWR majors parks',
    sinceVersion: '1.2.259',
    summary: 'Steady/HWR medium-major parks, soft-allow, Dip minor-lane recovery.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'expectancy_entry_skill',
    title: 'Expectancy + Entry Skill',
    sinceVersion: '1.2.266',
    summary: 'Expectancy repair pack, Entry Skill, unstick armed signals (unknown MC).',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'hybrid_admission',
    title: 'Hybrid admission modes',
    sinceVersion: '1.2.392',
    summary: 'Selective | Flow | Hybrid entry: park vs fast-arm near TA levels.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'microbot_mc_bands',
    title: 'Micro Bot live MC bands',
    sinceVersion: '1.2.385',
    summary: 'Min/Max MC on cards apply to fight, watch, and arm; watcher headers show live bands.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'watch_arm_ownership',
    title: 'Watch / arm ownership',
    sinceVersion: '1.2.381',
    summary: 'Arm timeout, Dip inserts, waiting-arm re-eval, conversion proof.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'system_load_mode',
    title: 'System Load Mode (services only)',
    sinceVersion: '1.2.421',
    summary: 'Basic / Premium / Full service gates. Does not remap RPC keys.',
    risk: 'product',
    status: 'pending',
  },
  {
    id: 'rpc_classic_three_lane',
    title: 'Classic three-lane RPC',
    sinceVersion: '1.2.64',
    summary: 'Helius / Alchemy / public share-load with latency EWMA and failover.',
    risk: 'rpc',
    status: 'pending',
  },
  {
    id: 'rpc_exclusive_keys',
    title: 'Exclusive 10-key RPC map',
    sinceVersion: '1.2.407',
    summary: 'One Alchemy/Helius key per major service; emergency publics only.',
    risk: 'rpc',
    status: 'pending',
  },
  {
    id: 'rpc_containment_spike',
    title: 'RPC containment + spike inspector',
    sinceVersion: '1.2.378',
    summary: 'Spike inspector, scanner shed, utility slowdown, capped entry pause.',
    risk: 'rpc',
    status: 'pending',
  },
  {
    id: 'rpc_load_mode_inventory',
    title: 'Load-mode RPC inventory',
    sinceVersion: '1.2.421',
    summary: 'Trading BACKUP / Scanner BACKUP2 / Watcher Helius / idle emergency slots.',
    risk: 'rpc',
    status: 'pending',
  },
  {
    id: 'zion_fight_log',
    title: 'Zion fight log + KOL extras',
    sinceVersion: '1.2.22',
    summary: 'Lane fight log persistence and extra Zion KOL scanner services.',
    risk: 'infra',
    status: 'pending',
  },
  {
    id: 'github_backup_hardening',
    title: 'GitHub backup hardening',
    sinceVersion: '1.2.214',
    summary: 'Keep auto-import off; 60s minimum gap between scheduled GitHub uploads.',
    risk: 'infra',
    status: 'ready',
  },
  {
    id: 'render_rpc_quiet_logs',
    title: 'Quiet soft RPC logs',
    sinceVersion: '1.2.402',
    summary: 'Soft 429/403 no longer flood Render as errors; exit/send stays loud.',
    risk: 'infra',
    status: 'pending',
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
