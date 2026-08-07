/**
 * Influencer / Top PnL Smart Mirror — additive watchlist + config.
 * Default OFF: Favourites / SMM behaviour unchanged.
 */

import { config, persistUserSettings, persistWallets, type SmartWallet } from './config';

export const INFLUENCER_FAMILY_TAGS = [
  'influencer',
  'top_pnl',
  'whale',
  'smart',
] as const;

export type InfluencerFamilyTag = (typeof INFLUENCER_FAMILY_TAGS)[number];

export interface InfluencerMirrorConfig {
  enabled: boolean;
  maxConcurrentMirrored: number;
  maxCopyDelayMs: number;
  minLiquidityUsd: number;
  minVolumeM5Usd: number;
  copySells: boolean;
  useJito: boolean;
  /**
   * Soft Gatekeeper for mirror path (default ON).
   * Soft activity floors are advisory; hard safety (anti-rug / honeypot) still absolute.
   */
  gatekeeperOptional: boolean;
  /** Optional partial sell % of initial (1–99); omit / 100 = full exit */
  partialSellPct?: number;
  /** Never sell positions that don't match the influencer source wallet */
  sellUnrelated: false;
  /** Defaults applied when Add Wallet / import creates tagged wallets */
  defaultTags: string[];
  defaultSizeMult: number;
  defaultFollowSells: boolean;
  defaultCopyEnabled: boolean;
}

export const DEFAULT_INFLUENCER_MIRROR: InfluencerMirrorConfig = {
  enabled: false,
  maxConcurrentMirrored: 3,
  maxCopyDelayMs: 15_000,
  minLiquidityUsd: 8_000,
  minVolumeM5Usd: 800,
  copySells: true,
  useJito: true,
  gatekeeperOptional: true,
  sellUnrelated: false,
  defaultTags: ['influencer', 'top_pnl'],
  defaultSizeMult: 1,
  defaultFollowSells: true,
  defaultCopyEnabled: true,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function clampSizeMult(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  return clamp(v, 0.25, 2);
}

function normalizeDefaultTags(raw: unknown): string[] {
  const base = Array.isArray(raw)
    ? normalizeWalletTags(raw as string[])
    : [...DEFAULT_INFLUENCER_MIRROR.defaultTags];
  if (!base.some((t) => (INFLUENCER_FAMILY_TAGS as readonly string[]).includes(t))) {
    base.push('influencer');
  }
  return base;
}

export function normalizeInfluencerMirrorConfig(
  raw?: Partial<InfluencerMirrorConfig> | null
): InfluencerMirrorConfig {
  const r = raw && typeof raw === 'object' ? raw : {};
  const partial = Number(r.partialSellPct);
  return {
    enabled: r.enabled === true,
    maxConcurrentMirrored: clamp(
      Math.round(Number(r.maxConcurrentMirrored) || DEFAULT_INFLUENCER_MIRROR.maxConcurrentMirrored),
      1,
      12
    ),
    maxCopyDelayMs: clamp(
      Math.round(Number(r.maxCopyDelayMs) || DEFAULT_INFLUENCER_MIRROR.maxCopyDelayMs),
      1_000,
      120_000
    ),
    minLiquidityUsd: clamp(
      Number(r.minLiquidityUsd) || DEFAULT_INFLUENCER_MIRROR.minLiquidityUsd,
      0,
      5_000_000
    ),
    minVolumeM5Usd: clamp(
      Number(r.minVolumeM5Usd) || DEFAULT_INFLUENCER_MIRROR.minVolumeM5Usd,
      0,
      5_000_000
    ),
    copySells: r.copySells !== false,
    useJito: r.useJito !== false,
    gatekeeperOptional: r.gatekeeperOptional !== false,
    partialSellPct:
      Number.isFinite(partial) && partial > 0 && partial < 100
        ? Math.round(partial)
        : undefined,
    sellUnrelated: false,
    defaultTags: normalizeDefaultTags(r.defaultTags),
    defaultSizeMult: clampSizeMult(
      r.defaultSizeMult ?? DEFAULT_INFLUENCER_MIRROR.defaultSizeMult
    ),
    defaultFollowSells: r.defaultFollowSells !== false,
    defaultCopyEnabled: r.defaultCopyEnabled !== false,
  };
}

export function getInfluencerMirrorConfig(): InfluencerMirrorConfig {
  try {
    return normalizeInfluencerMirrorConfig(
      config.influencerMirror as Partial<InfluencerMirrorConfig>
    );
  } catch {
    return { ...DEFAULT_INFLUENCER_MIRROR };
  }
}

export function isInfluencerMirrorEnabled(): boolean {
  return getInfluencerMirrorConfig().enabled === true;
}

export function normalizeWalletTags(tags?: string[] | null): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tags) {
    const s = String(t || '')
      .trim()
      .toLowerCase();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** influencer | top_pnl | whale | smart (case-insensitive) */
export function hasInfluencerFamilyTag(wallet: SmartWallet | null | undefined): boolean {
  if (!wallet) return false;
  const tags = normalizeWalletTags(wallet.tags);
  return tags.some((t) =>
    (INFLUENCER_FAMILY_TAGS as readonly string[]).includes(t)
  );
}

/**
 * Wallet eligible for fast mirror buy/sell when master is ON.
 * Requires influencer-family tag + enabled + copyEnabled (default true).
 */
export function isInfluencerMirrorWallet(
  wallet: SmartWallet | null | undefined
): boolean {
  if (!wallet || !wallet.enabled) return false;
  if (!hasInfluencerFamilyTag(wallet)) return false;
  if (wallet.copyEnabled === false) return false;
  return true;
}

export function walletFollowsSells(wallet: SmartWallet): boolean {
  if (wallet.followSells === false) return false;
  return true;
}

export function walletDisplayName(wallet: SmartWallet): string {
  return String(wallet.displayName || wallet.name || wallet.address.slice(0, 8)).trim();
}

export function applyInfluencerWalletDefaults(wallet: SmartWallet): SmartWallet {
  const tags = normalizeWalletTags(wallet.tags);
  const family = tags.some((t) =>
    (INFLUENCER_FAMILY_TAGS as readonly string[]).includes(t)
  );
  if (!family) return wallet;
  if (wallet.copyEnabled == null) wallet.copyEnabled = true;
  if (wallet.followSells == null) wallet.followSells = true;
  if (wallet.sizeMult == null) wallet.sizeMult = 1;
  else wallet.sizeMult = clampSizeMult(wallet.sizeMult);
  if (!wallet.displayName) wallet.displayName = wallet.name;
  return wallet;
}

export function setInfluencerMirrorEnabled(enabled: boolean): InfluencerMirrorConfig {
  const next = normalizeInfluencerMirrorConfig({
    ...getInfluencerMirrorConfig(),
    enabled: enabled === true,
  });
  config.influencerMirror = next;
  try {
    persistUserSettings();
  } catch {
    /* optional */
  }
  return next;
}

export function patchInfluencerMirrorConfig(
  patch: Partial<InfluencerMirrorConfig>
): InfluencerMirrorConfig {
  const next = normalizeInfluencerMirrorConfig({
    ...getInfluencerMirrorConfig(),
    ...patch,
  });
  config.influencerMirror = next;
  try {
    persistUserSettings();
  } catch {
    /* optional */
  }
  return next;
}

export function listInfluencerMirrorWallets(): SmartWallet[] {
  return (config.smartWallets || []).filter((w) => hasInfluencerFamilyTag(w));
}

export function patchInfluencerWallet(
  address: string,
  patch: Partial<SmartWallet>
): SmartWallet | null {
  const w = config.smartWallets.find((x) => x.address === address);
  if (!w) return null;
  if (patch.name != null) w.name = String(patch.name).trim() || w.name;
  if (patch.displayName != null) {
    w.displayName = String(patch.displayName).trim() || w.name;
  }
  if (typeof patch.enabled === 'boolean') w.enabled = patch.enabled;
  if (typeof patch.copyEnabled === 'boolean') w.copyEnabled = patch.copyEnabled;
  if (typeof patch.followSells === 'boolean') w.followSells = patch.followSells;
  if (patch.sizeMult != null) w.sizeMult = clampSizeMult(patch.sizeMult);
  if (Array.isArray(patch.tags)) {
    w.tags = normalizeWalletTags(patch.tags);
  }
  if (patch.pnl30dUsd != null && Number.isFinite(Number(patch.pnl30dUsd))) {
    w.pnl30dUsd = Number(patch.pnl30dUsd);
  }
  if (patch.winRate != null && Number.isFinite(Number(patch.winRate))) {
    w.winRate = Number(patch.winRate);
  }
  if (patch.volume30dUsd != null && Number.isFinite(Number(patch.volume30dUsd))) {
    w.volume30dUsd = Number(patch.volume30dUsd);
  }
  if (patch.lastActive != null && Number.isFinite(Number(patch.lastActive))) {
    w.lastActive = Number(patch.lastActive);
    w.lastTradedAt = w.lastActive;
  }
  applyInfluencerWalletDefaults(w);
  persistWallets();
  return w;
}

/** CSV header for influencer watchlist export/import */
export const INFLUENCER_CSV_HEADER =
  'address,name,displayName,tags,enabled,copyEnabled,followSells,sizeMult,pnl30dUsd,winRate,volume30dUsd,lastActive';

export function exportInfluencerWalletsCsv(): string {
  const rows = listInfluencerMirrorWallets();
  const lines = [INFLUENCER_CSV_HEADER];
  for (const w of rows) {
    const tags = normalizeWalletTags(w.tags).join('|');
    const cells = [
      w.address,
      csvEscape(w.name || ''),
      csvEscape(w.displayName || w.name || ''),
      csvEscape(tags),
      w.enabled !== false ? '1' : '0',
      w.copyEnabled !== false ? '1' : '0',
      w.followSells !== false ? '1' : '0',
      String(clampSizeMult(w.sizeMult ?? 1)),
      w.pnl30dUsd != null ? String(w.pnl30dUsd) : '',
      w.winRate != null ? String(w.winRate) : '',
      w.volume30dUsd != null ? String(w.volume30dUsd) : '',
      w.lastActive != null || w.lastTradedAt != null
        ? String(w.lastActive ?? w.lastTradedAt)
        : '',
    ];
    lines.push(cells.join(','));
  }
  return lines.join('\n') + '\n';
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQ = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function importInfluencerWalletsCsv(text: string): {
  added: number;
  updated: number;
  skipped: number;
} {
  const { upsertSmartWallet } =
    require('./config') as typeof import('./config');
  const { isValidSolanaAddress } =
    require('./walletStore') as typeof import('./walletStore');
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let added = 0;
  let updated = 0;
  let skipped = 0;
  let start = 0;
  if (lines[0] && /address/i.test(lines[0]) && /tag/i.test(lines[0])) {
    start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]!);
    const address = String(cols[0] || '').trim();
    if (!isValidSolanaAddress(address)) {
      skipped++;
      continue;
    }
    const name = String(cols[1] || '').trim() || address.slice(0, 8);
    const displayName = String(cols[2] || '').trim() || name;
    let tags = String(cols[3] || '')
      .split(/[|;]+/)
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    if (!tags.some((t) => (INFLUENCER_FAMILY_TAGS as readonly string[]).includes(t))) {
      tags = [...tags, 'influencer'];
    }
    const enabled = cols[4] == null || cols[4] === '' || /^(1|true|yes|on)$/i.test(cols[4]!);
    const copyEnabled =
      cols[5] == null || cols[5] === '' || /^(1|true|yes|on)$/i.test(cols[5]!);
    const followSells =
      cols[6] == null || cols[6] === '' || /^(1|true|yes|on)$/i.test(cols[6]!);
    const sizeMult = clampSizeMult(cols[7] ?? 1);
    const pnl30dUsd = Number(cols[8]);
    const winRate = Number(cols[9]);
    const volume30dUsd = Number(cols[10]);
    const lastActive = Number(cols[11]);
    const result = upsertSmartWallet({
      name,
      displayName,
      address,
      enabled,
      copyEnabled,
      followSells,
      sizeMult,
      tags,
      category: 'kol',
      source: 'bulk',
      discoveredAt: Date.now(),
      pnl30dUsd: Number.isFinite(pnl30dUsd) ? pnl30dUsd : undefined,
      winRate: Number.isFinite(winRate) ? winRate : undefined,
      volume30dUsd: Number.isFinite(volume30dUsd) ? volume30dUsd : undefined,
      lastActive: Number.isFinite(lastActive) && lastActive > 0 ? lastActive : undefined,
    });
    applyInfluencerWalletDefaults(
      config.smartWallets.find((w) => w.address === address)!
    );
    if (result.added) added++;
    else if (result.updated) updated++;
    else skipped++;
  }
  if (added + updated > 0) persistWallets();
  return { added, updated, skipped };
}

/**
 * Import / enrich from GMGN top wallets — fail soft.
 * Tags KOL-ish as influencer, PnL-ranked as top_pnl.
 */
export async function importInfluencerFromGmgn(opts?: {
  limit?: number;
  period?: '7d' | '30d';
  minWinRate?: number;
}): Promise<{
  imported: number;
  updated: number;
  error?: string;
  source?: string;
}> {
  try {
    const { getTopSmartWallets } =
      require('./gmgn') as typeof import('./gmgn');
    const { upsertSmartWallet } =
      require('./config') as typeof import('./config');
    const limit = Math.min(Math.max(opts?.limit ?? 30, 5), 100);
    const period = opts?.period === '7d' ? '7d' : '30d';
    const minWinRate = opts?.minWinRate ?? 35;
    const result = await getTopSmartWallets(limit, period, minWinRate);
    if (!result?.wallets?.length) {
      return {
        imported: 0,
        updated: 0,
        error: result?.error || 'GMGN returned no wallets',
        source: result?.source,
      };
    }
    let imported = 0;
    let updated = 0;
    const isKolPath =
      result.source === 'gmgn' &&
      Array.isArray(result.wallets) &&
      result.wallets.some((w) =>
        (w.tags || []).some((t) => /kol|renowned|influencer/i.test(t))
      );
    for (const row of result.wallets) {
      const gmgnTags = (row.tags || []).map((t) => String(t).toLowerCase());
      const tags = new Set<string>(['top_pnl']);
      if (
        isKolPath ||
        gmgnTags.some((t) => /kol|renowned|influencer|smart/i.test(t))
      ) {
        tags.add('influencer');
      }
      if (gmgnTags.some((t) => /whale/i.test(t))) tags.add('whale');
      tags.add('smart');
      const existing = config.smartWallets.find((w) => w.address === row.address);
      const r = upsertSmartWallet({
        name: row.name || row.address.slice(0, 8),
        displayName: row.name || row.address.slice(0, 8),
        address: row.address,
        enabled: existing?.enabled ?? true,
        copyEnabled: existing?.copyEnabled ?? true,
        followSells: existing?.followSells ?? true,
        sizeMult: existing?.sizeMult ?? 1,
        tags: [...tags],
        category: 'kol',
        source: 'gmgn',
        discoveredAt: existing?.discoveredAt ?? Date.now(),
        winRate: row.winRate > 0 ? row.winRate : existing?.winRate,
        pnl30dUsd:
          row.realizedPnl30d ??
          row.realizedPnlUsd ??
          existing?.pnl30dUsd,
        volume30dUsd: existing?.volume30dUsd,
        lastActive: row.lastActiveAt ?? existing?.lastActive,
        tradesLast7d: row.tradesLast7d ?? existing?.tradesLast7d,
        tradesLast30d: row.tradesLast30d ?? existing?.tradesLast30d,
      });
      const w = config.smartWallets.find((x) => x.address === row.address);
      if (w) applyInfluencerWalletDefaults(w);
      if (r.added) imported++;
      else if (r.updated) updated++;
    }
    if (imported + updated > 0) persistWallets();
    return {
      imported,
      updated,
      error: result.error,
      source: result.source,
    };
  } catch (err) {
    return {
      imported: 0,
      updated: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Add / upsert a single influencer wallet with family tags + GMGN enrich (fail soft).
 */
export async function addInfluencerWallet(input: {
  address: string;
  displayName?: string;
  name?: string;
  tags?: string[];
  sizeMult?: number;
  followSells?: boolean;
  copyEnabled?: boolean;
  enabled?: boolean;
}): Promise<{
  ok: boolean;
  added?: boolean;
  updated?: boolean;
  wallet?: SmartWallet;
  error?: string;
  enrichError?: string;
}> {
  const { upsertSmartWallet } =
    require('./config') as typeof import('./config');
  const { isValidSolanaAddress } =
    require('./walletStore') as typeof import('./walletStore');
  const address = String(input.address || '').trim();
  if (!isValidSolanaAddress(address)) {
    return { ok: false, error: 'Invalid Solana address' };
  }
  const im = getInfluencerMirrorConfig();
  let tags = normalizeWalletTags(
    input.tags?.length ? input.tags : im.defaultTags
  );
  if (!tags.some((t) => (INFLUENCER_FAMILY_TAGS as readonly string[]).includes(t))) {
    tags = [...tags, 'influencer'];
  }
  const existing = config.smartWallets.find((w) => w.address === address);
  const displayName =
    String(input.displayName || input.name || existing?.displayName || existing?.name || '')
      .trim() || address.slice(0, 8);

  let enrich: {
    name?: string;
    pnl30dUsd?: number;
    winRate?: number;
    lastActive?: number;
    tradesLast7d?: number;
    tradesLast30d?: number;
  } = {};
  let enrichError: string | undefined;
  try {
    const { getWalletActivity } = require('./gmgn') as typeof import('./gmgn');
    const act = await getWalletActivity(address);
    if (act && !act.error) {
      enrich = {
        name: displayName,
        pnl30dUsd:
          act.pnl30dUsd != null && Number.isFinite(act.pnl30dUsd)
            ? Number(act.pnl30dUsd)
            : undefined,
        winRate:
          act.winRate != null && Number.isFinite(act.winRate)
            ? Number(act.winRate)
            : undefined,
        lastActive: act.lastTradeTime ?? undefined,
        tradesLast7d: act.tradeCount7d ?? undefined,
        tradesLast30d: act.tradeCount30d ?? undefined,
      };
    } else if (act?.error) {
      enrichError = act.error;
    }
  } catch (err) {
    enrichError = err instanceof Error ? err.message : String(err);
  }

  const name =
    String(input.name || enrich.name || displayName).trim() || address.slice(0, 8);
  const result = upsertSmartWallet({
    name,
    displayName,
    address,
    enabled: input.enabled ?? existing?.enabled ?? true,
    copyEnabled:
      input.copyEnabled ?? existing?.copyEnabled ?? im.defaultCopyEnabled,
    followSells:
      input.followSells ?? existing?.followSells ?? im.defaultFollowSells,
    sizeMult: clampSizeMult(
      input.sizeMult ?? existing?.sizeMult ?? im.defaultSizeMult
    ),
    tags,
    category: 'kol',
    source: existing?.source ?? 'manual',
    discoveredAt: existing?.discoveredAt ?? Date.now(),
    pnl30dUsd: enrich.pnl30dUsd ?? existing?.pnl30dUsd,
    winRate: enrich.winRate ?? existing?.winRate,
    lastActive: enrich.lastActive ?? existing?.lastActive,
    tradesLast7d: enrich.tradesLast7d ?? existing?.tradesLast7d,
    tradesLast30d: enrich.tradesLast30d ?? existing?.tradesLast30d,
  });
  const w = config.smartWallets.find((x) => x.address === address);
  if (w) {
    w.displayName = displayName || w.displayName || w.name;
    w.copyEnabled =
      input.copyEnabled ?? w.copyEnabled ?? im.defaultCopyEnabled;
    w.followSells =
      input.followSells ?? w.followSells ?? im.defaultFollowSells;
    w.sizeMult = clampSizeMult(
      input.sizeMult ?? w.sizeMult ?? im.defaultSizeMult
    );
    w.tags = tags;
    if (enrich.pnl30dUsd != null) w.pnl30dUsd = enrich.pnl30dUsd;
    if (enrich.winRate != null) w.winRate = enrich.winRate;
    if (enrich.lastActive != null) w.lastActive = enrich.lastActive;
    applyInfluencerWalletDefaults(w);
    persistWallets();
  }
  return {
    ok: true,
    added: result.added,
    updated: result.updated,
    wallet: w,
    enrichError,
  };
}

/** Import from Jupiter influencers (fail soft) into influencer-tagged wallets. */
export async function importInfluencerFromJupiter(opts?: {
  limit?: number;
}): Promise<{
  imported: number;
  updated: number;
  error?: string;
  source?: string;
}> {
  try {
    const { fetchJupiterInfluencers } =
      require('./jupiterInfluencers') as typeof import('./jupiterInfluencers');
    const { upsertSmartWallet } =
      require('./config') as typeof import('./config');
    const limit = Math.min(Math.max(opts?.limit ?? 15, 1), 30);
    const result = await fetchJupiterInfluencers({ limit });
    if (!result.wallets.length) {
      return {
        imported: 0,
        updated: 0,
        error: result.error || 'Jupiter returned no influencers',
        source: result.source,
      };
    }
    const im = getInfluencerMirrorConfig();
    let imported = 0;
    let updated = 0;
    for (const row of result.wallets.slice(0, limit)) {
      const existing = config.smartWallets.find((w) => w.address === row.address);
      const tags = new Set<string>(['influencer', 'smart']);
      if (row.pnl30dUsd != null) tags.add('top_pnl');
      const r = upsertSmartWallet({
        name: row.name || row.address.slice(0, 8),
        displayName: row.name || row.address.slice(0, 8),
        address: row.address,
        enabled: existing?.enabled ?? true,
        copyEnabled: existing?.copyEnabled ?? im.defaultCopyEnabled,
        followSells: existing?.followSells ?? im.defaultFollowSells,
        sizeMult: existing?.sizeMult ?? im.defaultSizeMult,
        tags: [...tags],
        category: 'kol',
        source: 'jupiter' as SmartWallet['source'],
        discoveredAt: existing?.discoveredAt ?? Date.now(),
        winRate: row.winRate ?? existing?.winRate,
        pnl30dUsd: row.pnl30dUsd ?? existing?.pnl30dUsd,
        volume30dUsd: row.volume30dUsd ?? existing?.volume30dUsd,
        lastActive: row.lastActive ?? existing?.lastActive,
      });
      const w = config.smartWallets.find((x) => x.address === row.address);
      if (w) {
        w.displayName = row.name || w.displayName || w.name;
        w.copyEnabled = w.copyEnabled ?? im.defaultCopyEnabled;
        w.followSells = w.followSells ?? im.defaultFollowSells;
        w.sizeMult = clampSizeMult(w.sizeMult ?? im.defaultSizeMult);
        if (row.pnl30dUsd != null) w.pnl30dUsd = row.pnl30dUsd;
        if (row.winRate != null) w.winRate = row.winRate;
        if (row.volume30dUsd != null) w.volume30dUsd = row.volume30dUsd;
        applyInfluencerWalletDefaults(w);
      }
      if (r.added) imported++;
      else if (r.updated) updated++;
    }
    if (imported + updated > 0) persistWallets();
    return {
      imported,
      updated,
      error: result.error,
      source: result.source,
    };
  } catch (err) {
    return {
      imported: 0,
      updated: 0,
      error: err instanceof Error ? err.message : String(err),
      source: 'none',
    };
  }
}

/**
 * Top-N import: GMGN primary (30d PnL), Jupiter best-effort fail-soft.
 * `auto` = GMGN then Jupiter (Jupiter never blocks GMGN success).
 */
export async function importInfluencerTop(opts?: {
  limit?: number;
  period?: '7d' | '30d';
  source?: 'gmgn' | 'jupiter' | 'auto';
  minWinRate?: number;
}): Promise<{
  imported: number;
  updated: number;
  error?: string;
  source?: string;
  gmgn?: { imported: number; updated: number; error?: string; source?: string };
  jupiter?: { imported: number; updated: number; error?: string; source?: string };
}> {
  const limit = Math.min(Math.max(opts?.limit ?? 15, 5), 30);
  const period = opts?.period === '7d' ? '7d' : '30d';
  const source = opts?.source === 'jupiter' || opts?.source === 'auto' ? opts.source : 'gmgn';
  const minWinRate = opts?.minWinRate ?? 30;

  if (source === 'jupiter') {
    const j = await importInfluencerFromJupiter({ limit });
    return {
      imported: j.imported,
      updated: j.updated,
      error: j.error,
      source: j.source || 'jupiter',
      jupiter: j,
    };
  }

  const gmgn = await importInfluencerFromGmgn({ limit, period, minWinRate });
  // Prefer sorting by 30d PnL after import (already from GMGN orderby when available)
  const wallets = listInfluencerMirrorWallets()
    .slice()
    .sort((a, b) => (Number(b.pnl30dUsd) || 0) - (Number(a.pnl30dUsd) || 0));
  void wallets;

  if (source === 'gmgn') {
    return {
      imported: gmgn.imported,
      updated: gmgn.updated,
      error: gmgn.error,
      source: gmgn.source || 'gmgn',
      gmgn,
    };
  }

  // auto: always try Jupiter fail-soft; never undo GMGN
  const jup = await importInfluencerFromJupiter({ limit });
  const errors = [gmgn.error, jup.error].filter(Boolean);
  return {
    imported: gmgn.imported + jup.imported,
    updated: gmgn.updated + jup.updated,
    error: errors.length ? errors.join(' · ') : undefined,
    source: `gmgn:${gmgn.source || 'gmgn'}+jupiter:${jup.source || 'none'}`,
    gmgn,
    jupiter: jup,
  };
}

/** Top influencers by 30d PnL for Watchlist UI */
export function listTopInfluencerWallets(limit = 10): SmartWallet[] {
  return listInfluencerMirrorWallets()
    .filter((w) => w.enabled !== false)
    .slice()
    .sort((a, b) => (Number(b.pnl30dUsd) || 0) - (Number(a.pnl30dUsd) || 0))
    .slice(0, Math.min(Math.max(limit, 1), 20));
}

/** Prerequisites for live mirror path */
export function influencerMirrorPrereqsOk(): {
  ok: boolean;
  reason?: string;
} {
  try {
    const { isStrategyEnabled } =
      require('./strategies') as typeof import('./strategies');
    if (!isStrategyEnabled('smart_money_copy')) {
      return { ok: false, reason: 'smart_money_copy OFF' };
    }
  } catch {
    return { ok: false, reason: 'strategies unavailable' };
  }
  try {
    const profiles = config.tradeProfiles?.profiles || {};
    if (profiles.smart_money_mirror === false) {
      return { ok: false, reason: 'smart_money_mirror profile OFF' };
    }
  } catch {
    /* if tradeProfiles missing, allow — assign will fail soft */
  }
  return { ok: true };
}
