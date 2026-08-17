/**
 * Bot Info What's New — 1.2.424 Bot Learning pack.
 */

export const BOT_INFO_CHANGELOG = [
  {
    version: '1.2.424',
    title: 'Bot Learning pack (1.2.421 stack)',
    items: [
      'New Upgrades section: Bot Learning. Pack is default off on the 1.2.21 core.',
      'Enables the 1.2.421 self-learn stack: 400-episode film, Live Mode / dashboard-reset episode toggles, Learning Mode overlays, MARL + Profile RL + accelerator settings, quality-weighted expectancy, ML auto-advance, and the enhancements scheduler.',
    ],
  },
  {
    version: '1.2.423',
    title: 'Pre-built Upgrades catalog',
    items: [
      'Every Upgrades pack is pre-built and default off on the 1.2.21 core. Save & reboot applies only the packs you check.',
      'Tab groups: Watchlist, Trading, Zion, Learning, RPC, Dashboard cosmetics, Infra. RPC lane maps are exclusive; containment can stack.',
      'New packs: Watch List tab, Dashboard cosmetics, and 4-Lane RPC (Trading BACKUP, Scanner Helius backup, Data BACKUP2, Utility BACKUP3, idle publicnode/RPC_URL emergency).',
    ],
  },
  {
    version: '1.2.422',
    title: 'Restore 1.2.21 + Upgrades tab',
    items: [
      'Hard-restored the 1.2.21 core (pre-1.2.22) to exit the post-1.2.270 RPC lag spiral.',
      'Upgrades tab lists major packs from 1.2.22–1.2.421. All start OFF. Save & reboot applies ready packs only.',
      'GitHub auto-import on boot is forced off so later backups cannot replay 1.2.421 RPC settings onto this core.',
    ],
  },
] as const;
