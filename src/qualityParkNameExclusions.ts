/**
 * Name/symbol class exclusions for Steady/HWR medium–major quality parks.
 * Practical matching — exact tickers + clear name phrases; avoid over-blocking memes.
 * Do NOT use on Dip minors.
 */

export type QualityParkNameExclusionReason =
  | 'excluded_stable_or_major_asset_proxy'
  | 'excluded_stock_name_token';

/** Exact symbols: stables / cash / major quotes */
const STABLE_CASH_SYMBOLS = new Set(
  [
    'USD',
    'USDC',
    'USDT',
    'DAI',
    'USDS',
    'USDE',
    'USDe',
    'PYUSD',
    'EURC',
    'CASH',
    'FRAX',
    'UXD',
    'USDH',
    'USD1',
    'FDUSD',
    'TUSD',
    'GUSD',
    'BUSD',
  ].map((s) => s.toUpperCase())
);

/** Exact symbols: BTC / ETH / SOL major proxies (not meme *SOL endings) */
const MAJOR_ASSET_SYMBOLS = new Set(
  [
    'BTC',
    'WBTC',
    'CBTC',
    'TBTC',
    'BTC.B',
    'ETH',
    'WETH',
    'STETH',
    'WSTETH',
    'SOL',
    'WSOL',
    'JUP',
  ].map((s) => s.toUpperCase())
);

/** Known SOL liquid-staking / wrapper tickers (exact, case-insensitive) */
const SOL_LST_WRAPPER_SYMBOLS = new Set(
  [
    'JUPSOL',
    'MSOL',
    'BSOL',
    'STSOL',
    'JITOSOL',
    'BNSOL',
    'LAINESOL',
    'CGNTSOL',
    'HSOL',
    'INF',
    'JSOL',
    'VSOL',
    'LSOL',
    'DSOL',
    'ESOL',
    'HUBSOL',
  ].map((s) => s.toUpperCase())
);

/**
 * Curated equity tickers — exact symbol match only (no fuzzy "apple" in memes).
 */
const STOCK_NAME_SYMBOLS = new Set(
  [
    'AAPL',
    'TSLA',
    'NVDA',
    'AMZN',
    'MSFT',
    'GOOGL',
    'GOOG',
    'META',
    'NFLX',
    'AMD',
    'INTC',
    'IBM',
    'ORCL',
    'CRM',
    'UBER',
    'LYFT',
    'COIN',
    'HOOD',
    'PLTR',
    'SQ',
    'SHOP',
    'BA',
    'DIS',
    'NKE',
    'SBUX',
    'V',
    'MA',
    'JPM',
    'GS',
    'BAC',
    'WMT',
    'COST',
    'TGT',
    'XOM',
    'CVX',
    'SPY',
    'QQQ',
    'IWM',
    'DIA',
    'CRCL',
    'SPCX',
  ].map((s) => s.toUpperCase())
);

const STABLE_NAME_PHRASES = [
  'stablecoin',
  'usd coin',
  'tether',
  'pegged usd',
  'usd peg',
  'cash stable',
];

const MAJOR_PROXY_NAME_PHRASES = [
  'wrapped bitcoin',
  'wrapped btc',
  'wrapped ethereum',
  'wrapped ether',
  'wrapped eth',
  'wrapped sol',
  'wrapped solana',
  'liquid staking',
  'liquid staked sol',
  'staked sol',
];

function normSym(symbol: string | undefined | null): string {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function normName(name: string | undefined | null): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function nameEqualsMajorIdentity(name: string, symbol: string): boolean {
  const n = normName(name);
  if (!n) return false;
  // Whole-token identity for JUP / Jupiter governance — not "Jupiter meme xyz"
  if (symbol === 'JUP') {
    if (n === 'jupiter' || n === 'jupiter exchange' || n === 'jupiter ag') {
      return true;
    }
  }
  if (symbol === 'SOL' || symbol === 'WSOL') {
    if (n === 'solana' || n === 'wrapped solana' || n === 'wrapped sol') {
      return true;
    }
  }
  if (symbol === 'BTC' || symbol === 'WBTC' || symbol === 'CBTC') {
    if (
      n === 'bitcoin' ||
      n === 'wrapped bitcoin' ||
      n === 'wrapped btc' ||
      n === 'bitcoin (wormhole)'
    ) {
      return true;
    }
  }
  if (symbol === 'ETH' || symbol === 'WETH') {
    if (
      n === 'ethereum' ||
      n === 'wrapped ether' ||
      n === 'wrapped ethereum' ||
      n === 'ether'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Classify token name/symbol for Steady/HWR medium–major parks.
 * Returns null when the token is allowed.
 */
export function classifyQualityParkNameExclusion(
  symbol: string | undefined | null,
  name?: string | undefined | null
): QualityParkNameExclusionReason | null {
  const sym = normSym(symbol);
  const nm = normName(name);

  if (sym && STOCK_NAME_SYMBOLS.has(sym)) {
    return 'excluded_stock_name_token';
  }
  // Synthetic equity wrappers often append x (AAPLx, SPYx, NVDAx, COINx)
  if (sym && /^[A-Z]{2,5}X$/.test(sym)) {
    const base = sym.slice(0, -1);
    if (STOCK_NAME_SYMBOLS.has(base)) {
      return 'excluded_stock_name_token';
    }
  }

  if (sym && STABLE_CASH_SYMBOLS.has(sym)) {
    return 'excluded_stable_or_major_asset_proxy';
  }
  if (sym && MAJOR_ASSET_SYMBOLS.has(sym)) {
    return 'excluded_stable_or_major_asset_proxy';
  }
  if (sym && SOL_LST_WRAPPER_SYMBOLS.has(sym)) {
    return 'excluded_stable_or_major_asset_proxy';
  }

  if (nm) {
    for (const p of STABLE_NAME_PHRASES) {
      if (nm.includes(p)) return 'excluded_stable_or_major_asset_proxy';
    }
    for (const p of MAJOR_PROXY_NAME_PHRASES) {
      if (nm.includes(p)) return 'excluded_stable_or_major_asset_proxy';
    }
  }

  if (sym && nameEqualsMajorIdentity(nm, sym)) {
    return 'excluded_stable_or_major_asset_proxy';
  }

  return null;
}

export function isExcludedQualityParkName(
  symbol: string | undefined | null,
  name?: string | undefined | null
): boolean {
  return classifyQualityParkNameExclusion(symbol, name) != null;
}
