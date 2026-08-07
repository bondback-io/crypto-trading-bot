/**
 * Best-effort Jupiter Spot influencers fetch — fail soft.
 * Never throws to callers; returns empty + error when blocked/unavailable.
 */

export interface JupiterInfluencerRow {
  address: string;
  name: string;
  pnl30dUsd?: number;
  winRate?: number;
  volume30dUsd?: number;
  lastActive?: number;
}

const SOL_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const JSON_CANDIDATES = [
  'https://datapi.jup.ag/v1/smart-money/influencers?period=30d&limit=30',
  'https://datapi.jup.ag/v1/smartmoney/influencers?period=30d&limit=30',
  'https://lite-api.jup.ag/v2/smart-money/influencers?period=30d',
  'https://worker.jup.ag/smart-money/influencers?period=30d',
];

function isPlausibleSolAddress(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && s.length >= 32;
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function pickRows(data: unknown): JupiterInfluencerRow[] {
  if (!data) return [];
  const root = data as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(data)) candidates.push(...data);
  for (const k of [
    'data',
    'influencers',
    'traders',
    'wallets',
    'items',
    'results',
    'list',
  ]) {
    const v = root[k];
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === 'object') {
      const nested = v as Record<string, unknown>;
      for (const nk of ['data', 'influencers', 'traders', 'wallets', 'items']) {
        if (Array.isArray(nested[nk])) candidates.push(...(nested[nk] as unknown[]));
      }
    }
  }
  const out: JupiterInfluencerRow[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const address = String(
      r.address || r.wallet || r.walletAddress || r.owner || r.pubkey || ''
    ).trim();
    if (!isPlausibleSolAddress(address) || seen.has(address)) continue;
    seen.add(address);
    const name = String(
      r.name ||
        r.displayName ||
        r.handle ||
        r.twitter ||
        r.username ||
        address.slice(0, 8)
    ).trim();
    out.push({
      address,
      name: name.replace(/^@/, '') || address.slice(0, 8),
      pnl30dUsd: num(
        r.pnl30dUsd ?? r.pnl_30d ?? r.realizedPnl30d ?? r.pnl ?? r.pnlUsd
      ),
      winRate: num(r.winRate ?? r.win_rate ?? r.winrate),
      volume30dUsd: num(r.volume30dUsd ?? r.volume_30d ?? r.volume),
      lastActive: num(
        r.lastActive ?? r.last_active ?? r.lastTradeTime ?? r.updatedAt
      ),
    });
  }
  return out;
}

async function tryJsonEndpoint(
  url: string,
  timeoutMs: number
): Promise<JupiterInfluencerRow[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ZionTradingBot/1.2 (influencer-mirror; fail-soft)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const ct = String(res.headers.get('content-type') || '');
    if (!/json/i.test(ct) && !/javascript/i.test(ct)) {
      // still try parse — some APIs omit content-type
    }
    const data = await res.json().catch(() => null);
    const rows = pickRows(data);
    return rows.length ? rows : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Last-resort HTML scrape for base58 addresses (best-effort). */
async function tryHtmlScrape(timeoutMs: number): Promise<JupiterInfluencerRow[]> {
  const url = 'https://jup.ag/spot/smart-money/influencers';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html',
        'User-Agent': 'ZionTradingBot/1.2 (influencer-mirror; fail-soft)',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const html = await res.text();
    const matches = html.match(SOL_ADDR_RE) || [];
    const seen = new Set<string>();
    const out: JupiterInfluencerRow[] = [];
    for (const m of matches) {
      if (!isPlausibleSolAddress(m) || seen.has(m)) continue;
      // Skip known program / mint-ish noise (common short / system)
      if (m === '11111111111111111111111111111111') continue;
      seen.add(m);
      out.push({ address: m, name: m.slice(0, 8) });
      if (out.length >= 30) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch Jupiter influencers. Fail soft — never throws.
 */
export async function fetchJupiterInfluencers(opts?: {
  limit?: number;
}): Promise<{
  wallets: JupiterInfluencerRow[];
  error?: string;
  source?: string;
}> {
  const limit = Math.min(Math.max(opts?.limit ?? 15, 1), 30);
  const errors: string[] = [];

  for (const url of JSON_CANDIDATES) {
    const rows = await tryJsonEndpoint(url, 6_000);
    if (rows?.length) {
      return {
        wallets: rows.slice(0, limit),
        source: 'jupiter-json',
      };
    }
    errors.push(`json miss ${url.split('?')[0]}`);
  }

  const scraped = await tryHtmlScrape(8_000);
  if (scraped.length) {
    return {
      wallets: scraped.slice(0, limit),
      source: 'jupiter-html',
      error: errors.length
        ? 'JSON endpoints unavailable — HTML scrape used'
        : undefined,
    };
  }

  return {
    wallets: [],
    error:
      errors.slice(0, 2).join('; ') ||
      'Jupiter influencers unavailable (blocked or changed)',
    source: 'none',
  };
}
