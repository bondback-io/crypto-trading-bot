/**
 * Known Solana stables / major quote tokens — never copy-trade these as
 * meme targets. Use mint addresses only (symbols are spoofable).
 */

/** Wrapped SOL (native quote) — same as config.solMint */
export const WSOL_MINT =
  'So11111111111111111111111111111111111111112';

/**
 * Mainnet stables / USD-pegged quote assets that must never be opened
 * as copy-trade positions (balance increases look like "buys").
 */
export const DENIED_COPY_MINTS: ReadonlySet<string> = new Set([
  // Circle / Tether / PayPal / Sky / Ethena / Circle EUR
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USDSwr9ApdHk5bvJKMjzff41Ffuq8GGBsEP3VPeSJseNJ', // USDS
  'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', // USDe
  'HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDX3S', // EURC
  // Wormhole / Portal bridged stables (still common as swap legs)
  'A9mUU4qviSctJVPJdBJWssHqWsqqNxXSrwmA8YgL6T3h', // Portal USDC
  'Dn4noZ5jgGfkntVuWbgsorqV2fqAsAbsvd5nJ2kEbnw', // Portal USDT
]);

/**
 * True when `mint` is wrapped SOL or a known stable/quote asset.
 * Never open, copy, or record these as meme closed trades.
 */
export function isDeniedCopyMint(
  mint: string,
  solMint: string = WSOL_MINT
): boolean {
  return mint === solMint || DENIED_COPY_MINTS.has(mint);
}
