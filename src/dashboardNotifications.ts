/**
 * In-app dashboard notification feed (bell).
 * Durable under data/dashboard-notifications.json — survives restarts when DATA_DIR is durable.
 */

import {
  atomicWriteJson,
  dataFile,
  ensureDataDir,
  readJsonFile,
} from './dataDir';
import { config } from './config';

export type DashboardNotificationKind =
  | 'trade_request'
  | 'email'
  | 'profit_close'
  | 'version'
  | 'system'
  | 'error';

export interface DashboardNotification {
  id: string;
  kind: DashboardNotificationKind;
  title: string;
  body: string;
  at: number;
  read: boolean;
  /** Optional deep-link / action payload */
  href?: string;
  offerId?: string;
  mint?: string;
  symbol?: string;
  emailKind?: string;
  meta?: Record<string, unknown>;
}

interface StoreFile {
  version: 1;
  items: DashboardNotification[];
  lastSeenAppVersion?: string | null;
}

const FILE = () => dataFile('dashboard-notifications.json');
const MAX_ITEMS = 120;

let cache: StoreFile | null = null;

function ensureLoaded(): StoreFile {
  if (cache) return cache;
  ensureDataDir();
  const raw = readJsonFile<StoreFile>(FILE());
  if (raw && Array.isArray(raw.items)) {
    cache = {
      version: 1,
      items: raw.items.slice(0, MAX_ITEMS),
      lastSeenAppVersion:
        typeof raw.lastSeenAppVersion === 'string'
          ? raw.lastSeenAppVersion
          : null,
    };
  } else {
    cache = { version: 1, items: [], lastSeenAppVersion: null };
  }
  return cache;
}

/** Drop in-memory cache so next read reloads from disk (e.g. after site restore). */
export function invalidateDashboardNotificationsCache(): void {
  cache = null;
}

function persist(): void {
  const s = ensureLoaded();
  try {
    atomicWriteJson(FILE(), s);
  } catch (err) {
    console.warn(
      '[dashboard-notify] persist failed:',
      err instanceof Error ? err.message : err
    );
  }
}

function newId(): string {
  return `dn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isDashboardNotifyEnabled(): boolean {
  return config.notifications?.dashboardEnabled !== false;
}

export function isTradeRequestSoundEnabled(): boolean {
  return config.notifications?.tradeRequestSound !== false;
}

export function isProfitCloseSoundEnabled(): boolean {
  return config.notifications?.profitCloseSound !== false;
}

export function isZionPlaceTradeSoundEnabled(): boolean {
  return config.notifications?.zionPlaceTradeSound !== false;
}

export function isZionChatReplySoundEnabled(): boolean {
  return config.notifications?.zionChatReplySound !== false;
}

export function isTradeOpenSoundEnabled(): boolean {
  return config.notifications?.tradeOpenSound !== false;
}

export function isTradeCloseSoundEnabled(): boolean {
  return config.notifications?.tradeCloseSound !== false;
}

export function isTradeRequestPopupEnabled(): boolean {
  return config.notifications?.tradeRequestPopups !== false;
}

export function pushDashboardNotification(
  input: Omit<DashboardNotification, 'id' | 'at' | 'read'> & {
    at?: number;
    read?: boolean;
    id?: string;
  }
): DashboardNotification | null {
  if (!isDashboardNotifyEnabled()) return null;
  const store = ensureLoaded();
  const item: DashboardNotification = {
    id: input.id || newId(),
    kind: input.kind,
    title: String(input.title || '').slice(0, 160),
    body: String(input.body || '').slice(0, 400),
    at: input.at ?? Date.now(),
    read: input.read === true,
    href: input.href,
    offerId: input.offerId,
    mint: input.mint,
    symbol: input.symbol,
    emailKind: input.emailKind,
    meta: input.meta,
  };
  store.items.unshift(item);
  if (store.items.length > MAX_ITEMS) store.items.length = MAX_ITEMS;
  persist();
  return item;
}

export function listDashboardNotifications(limit = 40): {
  items: DashboardNotification[];
  unread: number;
} {
  const store = ensureLoaded();
  const items = store.items.slice(0, Math.max(1, Math.min(100, limit)));
  const unread = store.items.filter((i) => !i.read).length;
  return { items, unread };
}

export function markDashboardNotificationRead(
  id?: string
): { ok: boolean; unread: number } {
  const store = ensureLoaded();
  if (!id) {
    for (const i of store.items) i.read = true;
  } else {
    const hit = store.items.find((i) => i.id === id);
    if (hit) hit.read = true;
  }
  persist();
  return {
    ok: true,
    unread: store.items.filter((i) => !i.read).length,
  };
}

export function clearDashboardNotifications(): { ok: boolean } {
  const store = ensureLoaded();
  store.items = [];
  persist();
  return { ok: true };
}

/**
 * On boot: if app version changed since last seen, push a "new version" note.
 */
export function maybeNotifyAppVersionUpdate(versionLabel: string): void {
  if (!versionLabel) return;
  const store = ensureLoaded();
  const prev = store.lastSeenAppVersion;
  store.lastSeenAppVersion = versionLabel;
  persist();
  if (!prev || prev === versionLabel) return;
  pushDashboardNotification({
    kind: 'version',
    title: 'App updated',
    body: `Running ${versionLabel} (was ${prev})`,
    meta: { previous: prev, current: versionLabel },
  });
}

/** Friendly labels for email notification kinds. */
export function emailKindLabel(kind: string): string {
  switch (kind) {
    case 'lowEquity':
      return 'Low equity alert';
    case 'insufficientFunds':
      return 'Insufficient funds';
    case 'profitableClose':
      return 'Profitable close email';
    case 'zionTradeOffer':
      return 'Zion trade request email';
    case 'zionTradePlaced':
      return 'Zion trade placed email';
    case 'zionImprovementRequest':
      return 'Zion improvement request email';
    case 'test':
      return 'Test email';
    default:
      return kind || 'Email';
  }
}
