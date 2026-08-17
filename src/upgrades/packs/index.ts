import {
  disableGithubBackupHardening,
  enableGithubBackupHardening,
} from './githubBackupHardening';
import { makeFlagPack } from './flagPack';
import { makeRpcLanePack } from './rpcLane';
import { disableQuietRpcLogs, enableQuietRpcLogs } from './quietLogs';
import { disableZionPlatinum, enableZionPlatinum } from './zionPlatinum';
import { disableZionFightLog, enableZionFightLog } from './zionFightLog';
import {
  disableMajorsDipWatch,
  enableMajorsDipWatch,
} from './majorsDipWatch';
import {
  disableInfluencerMirror,
  enableInfluencerMirror,
} from './influencerMirror';
import {
  disableSystemLoadMode,
  enableSystemLoadMode,
} from './systemLoadMode';
import { disableBotLearning421, enableBotLearning421 } from './botLearning';

export interface UpgradePackRuntime {
  enable: () => void;
  disable: () => void;
}

const RUNTIMES: Record<string, UpgradePackRuntime> = {
  watchlist_tab: makeFlagPack(
    'watchlist_tab',
    'Live Feed becomes Watchlist after apply'
  ),
  majors_dip_watch: {
    enable: enableMajorsDipWatch,
    disable: disableMajorsDipWatch,
  },
  influencer_mirror: {
    enable: enableInfluencerMirror,
    disable: disableInfluencerMirror,
  },
  scalper_mode_b: makeFlagPack(
    'scalper_mode_b',
    'Mode B support-reclaim preference'
  ),
  steady_hwr_majors: makeFlagPack(
    'steady_hwr_majors',
    'Steady/HWR aged majors parks'
  ),
  expectancy_entry_skill: makeFlagPack(
    'expectancy_entry_skill',
    'armed unknown-MC soft-pass'
  ),
  hybrid_admission: makeFlagPack(
    'hybrid_admission',
    'Hybrid park vs fast-arm'
  ),
  microbot_mc_bands: makeFlagPack(
    'microbot_mc_bands',
    'live MC bands on watch/arm'
  ),
  watch_arm_ownership: makeFlagPack(
    'watch_arm_ownership',
    '20m arm timeout on owned Dip watches'
  ),
  system_load_mode: {
    enable: enableSystemLoadMode,
    disable: disableSystemLoadMode,
  },
  zion_platinum: {
    enable: enableZionPlatinum,
    disable: disableZionPlatinum,
  },
  zion_fight_log: {
    enable: enableZionFightLog,
    disable: disableZionFightLog,
  },
  trade_craft_learning: makeFlagPack(
    'trade_craft_learning',
    'Trade Craft scorecard + soft craft nudges'
  ),
  bot_learning_421: {
    enable: enableBotLearning421,
    disable: disableBotLearning421,
  },
  rpc_classic_three_lane: makeRpcLanePack(
    'rpc_classic_three_lane',
    'Helius / Alchemy / public'
  ),
  rpc_exclusive_keys: makeRpcLanePack(
    'rpc_exclusive_keys',
    'exclusive key map'
  ),
  rpc_load_mode_inventory: makeRpcLanePack(
    'rpc_load_mode_inventory',
    'BACKUP / BACKUP2 / Helius'
  ),
  rpc_four_lane: makeRpcLanePack(
    'rpc_four_lane',
    'Trading BACKUP · Scanner Helius backup · Data BACKUP2 · Utility BACKUP3'
  ),
  rpc_containment_spike: makeFlagPack(
    'rpc_containment_spike',
    'skip idle emergency probes while preferred is healthy'
  ),
  dashboard_cosmetics: makeFlagPack(
    'dashboard_cosmetics',
    'header/session, peach buttons, cog order'
  ),
  github_backup_hardening: {
    enable: enableGithubBackupHardening,
    disable: disableGithubBackupHardening,
  },
  render_rpc_quiet_logs: {
    enable: enableQuietRpcLogs,
    disable: disableQuietRpcLogs,
  },
};

export function getUpgradeRuntime(id: string): UpgradePackRuntime | undefined {
  return RUNTIMES[id];
}
