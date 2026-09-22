// Degen exclusion gate. Pure, dependency-free, shared by intel-degen and its
// tests.
//
// The Degen screener reads a DEX-discovery cache, so the "verified" set is full
// of things that are not memecoins: stablecoins, majors, wrapped and staked
// receipts, homoglyph impersonations of all of those, and rows whose reported
// market cap is arithmetic nonsense (a $57.8T cap sitting on $50k of
// liquidity). None of them belong in a memecoin screener, and the impersonators
// are actively dangerous, so every row is classified before any bucket gate
// runs.
//
// Nothing here is a judgement about an asset: a row is either not a memecoin,
// or it is pretending to be something it is not, or its own numbers contradict
// each other. The reason travels with the row so the UI can show the excluded
// set instead of silently shrinking the table.

export type DegenExclusionReason =
  | 'stablecoin'
  | 'major'
  | 'wrapped_or_staked'
  | 'impersonation'
  | 'implausible_cap'

export interface DegenExclusion {
  reason: DegenExclusionReason
  detail: string
}

export interface DegenGateRow {
  chain?: unknown
  token_address?: unknown
  tokenAddress?: unknown
  symbol?: unknown
  name?: unknown
  market_cap?: unknown
  marketCap?: unknown
  liquidity_usd?: unknown
  liquidityUsd?: unknown
  [key: string]: unknown
}

export interface DegenGateContext {
  /** `chain:address` keys built with contractKey() from market_assets.platforms. */
  catalogueContracts?: Set<string> | null
  now?: number
}

// ── thresholds ───────────────────────────────────────────────────────────────
// A memecoin with a real $5B market cap does not exist outside the catalogue;
// above that line the number is a supply-decimals bug or a deliberate lie.
export const IMPLAUSIBLE_CAP_USD = 5_000_000_000
// Ten thousand dollars of "market cap" per dollar of pooled liquidity. Real
// tokens sit far below this; fabricated caps sit orders of magnitude above.
export const IMPLAUSIBLE_CAP_LIQUIDITY_RATIO = 10_000

// ── normalisation ────────────────────────────────────────────────────────────

// Zero-width, bidi, joiner, BOM, soft hyphen and variation selectors. These
// carry no glyph, so a symbol containing them looks identical to one that does
// not — which is exactly why impersonators use them.
const INVISIBLE = /[­​-‏‪-‮⁠-⁤︀-️﻿]/g

// Look-alike code points that NFKC does NOT fold. NFKC already handles the
// fullwidth forms, the Roman numerals (Ⅽ Ⅾ) and the mathematical
// alphanumerics, so only the genuinely distinct scripts are listed: Greek,
// Cyrillic, Armenian, Cherokee and the Latin small-capital letters.
export const CONFUSABLES: Record<string, string> = {
  // A
  'Α': 'A', 'А': 'A', 'а': 'A', 'Ꭺ': 'A', 'ᴀ': 'A',
  // B
  'Β': 'B', 'В': 'B', 'Ᏼ': 'B', 'ʙ': 'B',
  // C
  'Ϲ': 'C', 'С': 'C', 'с': 'C', 'Ꮯ': 'C', 'ᴄ': 'C', 'Ⅽ': 'C',
  // D
  'Ꭰ': 'D', 'Ⅾ': 'D', 'ᴅ': 'D', 'Ԁ': 'D',
  // E
  'Ε': 'E', 'Е': 'E', 'е': 'E', 'Ꭼ': 'E', 'ᴇ': 'E',
  // H
  'Η': 'H', 'Н': 'H', 'н': 'H', 'Ꮋ': 'H', 'ʜ': 'H',
  // I
  'Ι': 'I', 'І': 'I', 'і': 'I', 'Ӏ': 'I', 'Ⅰ': 'I', 'ɪ': 'I',
  // K
  'Κ': 'K', 'К': 'K', 'к': 'K', 'Ꮶ': 'K', 'ᴋ': 'K',
  // M
  'Μ': 'M', 'М': 'M', 'м': 'M', 'Ꮇ': 'M', 'ᴍ': 'M',
  // N
  'Ν': 'N', 'ᴎ': 'N',
  // O
  'Ο': 'O', 'О': 'O', 'о': 'O', 'Օ': 'O', 'օ': 'O', 'ᴏ': 'O',
  // P
  'Ρ': 'P', 'Р': 'P', 'р': 'P', 'Ꮲ': 'P', 'ᴘ': 'P',
  // R
  'Ꭱ': 'R', 'ʀ': 'R',
  // S
  'Ѕ': 'S', 'ѕ': 'S', 'Տ': 'S', 'տ': 'S', 'Ꮪ': 'S', 'ꜱ': 'S',
  // T
  'Τ': 'T', 'Т': 'T', 'Ꭲ': 'T', 'ᴛ': 'T',
  // U
  'Ս': 'U', 'ս': 'U', 'ᴜ': 'U',
  // X
  'Χ': 'X', 'Х': 'X', 'х': 'X',
  // Y
  'Υ': 'Y', 'У': 'Y', 'у': 'Y', 'Ү': 'Y', 'ʏ': 'Y',
  // Z
  'Ζ': 'Z', 'ᴢ': 'Z',
  // digits
  'З': '3', 'Ч': '4', 'б': '6', 'ӏ': '1', 'Ơ': 'O',
}

/**
 * NFKC, invisibles stripped, look-alikes folded to ASCII, a leading `$`
 * removed, whitespace collapsed, uppercased. The result is what a reader
 * actually SEES, which is the only form worth comparing against a deny list.
 */
export function normalizeSymbol(input: unknown): string {
  const raw = typeof input === 'string' ? input : input == null ? '' : String(input)
  let out = ''
  for (const ch of raw.normalize('NFKC').replace(INVISIBLE, '')) out += CONFUSABLES[ch] ?? ch
  return out.trim().replace(/^\$+/, '').replace(/\s+/g, ' ').trim().toUpperCase()
}

/** Same folding for display names; the `$` strip is a no-op on a real name. */
export const normalizeName = (input: unknown): string => normalizeSymbol(input)

// A symbol written entirely in ASCII can never be a homoglyph attack: the
// reader sees the same bytes the matcher does. Case and a leading `$` are not
// deception, so they are folded before the comparison.
const ASCII_ONLY = /^[\x20-\x7E]*$/
const asciiFold = (raw: string) => raw.trim().replace(/^\$+/, '').replace(/\s+/g, ' ').trim().toUpperCase()

// ── deny lists ───────────────────────────────────────────────────────────────

export const STABLECOIN_SYMBOLS = new Set([
  'USDT', 'USDC', 'DAI', 'USDE', 'USD1', 'PYUSD', 'TUSD', 'USDP', 'FDUSD', 'USDS',
  'EURC', 'EURO', 'EURS', 'EURT',
])

// Gas tokens and the assets an impersonator wants to be mistaken for.
export const MAJOR_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'BNB'])

export const WRAPPED_SYMBOLS = new Set([
  'WETH', 'WBTC', 'STETH', 'WSTETH', 'CBBTC', 'CBETH', 'WEETH', 'RETH', 'TBTC',
  'WBNB', 'BTCB', 'WSOL', 'MSOL', 'JITOSOL', 'BSOL', 'BNSOL',
])

// Exact display names of the assets above. A row calling itself "Tether USD"
// is not a memecoin whatever ticker it prints.
export const EXCLUDED_NAMES: Record<string, DegenExclusionReason> = {
  'TETHER USD': 'stablecoin',
  'USD COIN': 'stablecoin',
  'WRAPPED ETHER': 'wrapped_or_staked',
  'WRAPPED BTC': 'wrapped_or_staked',
  'LIDO STAKED ETHER': 'wrapped_or_staked',
  BITCOIN: 'major',
  ETHEREUM: 'major',
  SOLANA: 'major',
  BNB: 'major',
}

// Non-Latin names used AS a ticker. They survive normalisation unchanged
// (CJK has no ASCII fold), so the deny lists would never see them.
const SYMBOL_ALIASES: Record<string, string> = {
  '比特币': 'BTC', // bitcoin
  '以太坊': 'ETH', // ethereum
  '泰达币': 'USDT', // tether
  '索拉纳': 'SOL', // solana
}

const listedReason = (symbol: string): DegenExclusionReason | null => {
  const sym = SYMBOL_ALIASES[symbol] ?? symbol
  if (!sym) return null
  if (STABLECOIN_SYMBOLS.has(sym)) return 'stablecoin'
  if (MAJOR_SYMBOLS.has(sym)) return 'major'
  if (WRAPPED_SYMBOLS.has(sym)) return 'wrapped_or_staked'
  return null
}

// ── contracts ────────────────────────────────────────────────────────────────

const CHAIN_ALIASES: Record<string, string> = {
  eth: 'ethereum', ethereum: 'ethereum', mainnet: 'ethereum', 'eip155:1': 'ethereum', 'ethereum-mainnet': 'ethereum',
  base: 'base', 'eip155:8453': 'base',
  bsc: 'bsc', bnb: 'bsc', 'bnb-chain': 'bsc', 'bnb-smart-chain': 'bsc', 'binance-smart-chain': 'bsc', 'eip155:56': 'bsc',
  solana: 'solana', sol: 'solana',
}

export const normalizeChain = (chain: unknown): string => {
  const key = String(chain ?? '').trim().toLowerCase()
  return CHAIN_ALIASES[key] ?? key
}

/**
 * `chain:address`. EVM addresses lower-case (they are case-insensitive, and the
 * checksum casing is cosmetic); Solana mint addresses keep their case, because
 * base58 IS case-sensitive and lower-casing one produces a different mint.
 */
export function contractKey(chain: unknown, address: unknown): string {
  const c = normalizeChain(chain)
  const a = String(address ?? '').trim()
  if (!c || !a) return ''
  return `${c}:${c === 'solana' ? a : a.toLowerCase()}`
}

export interface CanonicalContract {
  chain: string
  address: string
  symbol: string
  reason: DegenExclusionReason
}

// The addresses themselves are the identity. A row sitting on one of these is
// the real asset (or a pool of it) no matter what ticker it advertises, which
// is what catches an impersonator that got the symbol past the fold.
export const CANONICAL_CONTRACTS: CanonicalContract[] = [
  // Ethereum
  { chain: 'ethereum', address: '0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0x6b175474e89094c44da98b954eedeac495271d0f', symbol: 'DAI', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0x4c9edd5852cd905f086c759e8383e09bff1e68b3', symbol: 'USDe', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d', symbol: 'USD1', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0x6c3ea9036406852006290770bedfcaba0e23a0e8', symbol: 'PYUSD', reason: 'stablecoin' },
  { chain: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84', symbol: 'stETH', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', symbol: 'wstETH', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee', symbol: 'weETH', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0xae78736cd615f374d3085123a210448e74fc6393', symbol: 'rETH', reason: 'wrapped_or_staked' },
  { chain: 'ethereum', address: '0x18084fba666a33d37592fa2633fd49a74dd93a88', symbol: 'tBTC', reason: 'wrapped_or_staked' },
  // Base
  { chain: 'base', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', reason: 'stablecoin' },
  { chain: 'base', address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', reason: 'wrapped_or_staked' },
  { chain: 'base', address: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', symbol: 'cbBTC', reason: 'wrapped_or_staked' },
  // BNB chain
  { chain: 'bsc', address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', reason: 'stablecoin' },
  { chain: 'bsc', address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', reason: 'stablecoin' },
  { chain: 'bsc', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', reason: 'wrapped_or_staked' },
  { chain: 'bsc', address: '0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c', symbol: 'BTCB', reason: 'wrapped_or_staked' },
  { chain: 'bsc', address: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', symbol: 'ETH', reason: 'major' },
  // Solana
  { chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', reason: 'stablecoin' },
  { chain: 'solana', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', reason: 'stablecoin' },
  { chain: 'solana', address: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', symbol: 'PYUSD', reason: 'stablecoin' },
  { chain: 'solana', address: 'DEkqHyPN7GMRJ5cArtQFAWefqbZb33Hyf6s5iCwjEonT', symbol: 'USDe', reason: 'stablecoin' },
  { chain: 'solana', address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', reason: 'wrapped_or_staked' },
  { chain: 'solana', address: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'mSOL', reason: 'wrapped_or_staked' },
  { chain: 'solana', address: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', reason: 'wrapped_or_staked' },
  { chain: 'solana', address: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', symbol: 'bSOL', reason: 'wrapped_or_staked' },
]

export const CANONICAL_CONTRACT_MAP: Map<string, CanonicalContract> = new Map(
  CANONICAL_CONTRACTS.map((entry) => [contractKey(entry.chain, entry.address), entry]),
)

// ── classification ───────────────────────────────────────────────────────────

const finite = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const usd = (n: number): string => {
  const abs = Math.abs(n)
  const unit = abs >= 1e12 ? ['T', 1e12] : abs >= 1e9 ? ['B', 1e9] : abs >= 1e6 ? ['M', 1e6] : abs >= 1e3 ? ['K', 1e3] : ['', 1]
  return `$${(n / (unit[1] as number)).toFixed(2)}${unit[0]}`
}

/**
 * `null` when the row belongs in the screener, otherwise the reason it does
 * not. Order is deliberate: the contract is the strongest identity, an
 * impersonation has to be named as one before the deny list turns it into a
 * plain "stablecoin", and the arithmetic check runs last so a row is only
 * called implausible when nothing better describes it.
 */
export function classifyDegenRow(row: DegenGateRow | null | undefined, ctx: DegenGateContext = {}): DegenExclusion | null {
  if (!row) return null
  const chain = row.chain
  const address = row.token_address ?? row.tokenAddress
  const rawSymbol = typeof row.symbol === 'string' ? row.symbol : row.symbol == null ? '' : String(row.symbol)
  const symbol = normalizeSymbol(rawSymbol)
  const name = normalizeName(row.name)

  // (b) canonical contract — wins over whatever the row calls itself.
  const key = contractKey(chain, address)
  const canonical = key ? CANONICAL_CONTRACT_MAP.get(key) : undefined
  if (canonical) {
    return { reason: canonical.reason, detail: `${key} is the canonical ${canonical.symbol} contract` }
  }

  // (c) homoglyph impersonation — a non-ASCII symbol that folds onto a listed one.
  const asciiIdentical = ASCII_ONLY.test(rawSymbol) && asciiFold(rawSymbol) === symbol
  if (!asciiIdentical) {
    const impersonated = listedReason(symbol)
    if (impersonated) {
      const target = SYMBOL_ALIASES[symbol] ?? symbol
      return { reason: 'impersonation', detail: `symbol "${rawSymbol}" reads as ${target}` }
    }
  }

  // (a) plain deny list, by symbol then by exact name.
  const bySymbol = listedReason(symbol)
  if (bySymbol) return { reason: bySymbol, detail: `symbol ${symbol} is not a memecoin` }
  const byName = EXCLUDED_NAMES[name]
  if (byName) return { reason: byName, detail: `name "${String(row.name ?? '')}" is not a memecoin` }

  // (d) arithmetic. Zero is a valid market cap (unpriced launch), so only a
  // positive cap can be implausible. The ratio test needs real liquidity on the
  // other side, or every pre-liquidity launch would be thrown out with it.
  const cap = finite(row.market_cap ?? row.marketCap)
  const liq = finite(row.liquidity_usd ?? row.liquidityUsd)
  if (cap != null && cap > 0) {
    const catalogued = ctx.catalogueContracts instanceof Set && key ? ctx.catalogueContracts.has(key) : false
    if (cap > IMPLAUSIBLE_CAP_USD && !catalogued) {
      return { reason: 'implausible_cap', detail: `market cap ${usd(cap)} exceeds ${usd(IMPLAUSIBLE_CAP_USD)} and the token is not in the catalogue` }
    }
    if (liq != null && liq > 0 && cap > IMPLAUSIBLE_CAP_LIQUIDITY_RATIO * liq) {
      return { reason: 'implausible_cap', detail: `market cap ${usd(cap)} is over ${IMPLAUSIBLE_CAP_LIQUIDITY_RATIO.toLocaleString('en-US')}x the ${usd(liq)} of liquidity` }
    }
  }

  return null
}

export const DEGEN_EXCLUSION_REASONS: DegenExclusionReason[] = [
  'stablecoin', 'major', 'wrapped_or_staked', 'impersonation', 'implausible_cap',
]
