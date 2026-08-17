/**
 * Bot Info What's New — 1.2.422 restore baseline.
 * 1.2.21 check:botinfo does not require this catalog; keep in sync with package.json.
 */

export const BOT_INFO_CHANGELOG = [
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
