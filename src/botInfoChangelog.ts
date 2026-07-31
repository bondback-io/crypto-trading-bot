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
