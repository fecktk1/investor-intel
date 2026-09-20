// Investor Intel — WHAT IS ON THE OTHER SIDE OF AN RWA POOL.
//
// ── THE DEFECT THIS EXISTS TO FIX ────────────────────────────────────────────
// CoinMarketCap's `liqUsd` on a DEX pool values BOTH legs. A pool whose other
// leg is a token nobody can value therefore reports a large USD figure that no
// seller could ever take out. Production, 2026-09-20, first run of the depth
// lane:
//
//   XAUt   deepest pool `XAUt / GOLDGR` on PancakeSwap v3 (Ethereum), reported
//          $16.5M, 24-hour volume $812. That one pool was 31 percent of the
//          $52.8M headline.
//   SLVon  deepest pool `u / SLVon` on Uniswap v3 (Ethereum), reported $10.4M
//          with zero 24-hour volume, against a $25.5M token market cap, while
//          its real `USDC / SLVon` pool holds $0.56M.
//
// The board's question is "where can this actually be sold". Presenting either
// of those as depth is the opposite of the truth, so the headline figures are
// built only from pools whose other leg is something a reader can value.
//
// ── CLASSIFICATION IS BY CONTRACT ADDRESS, NEVER BY SYMBOL ───────────────────
// A worthless token can call itself USDC, and on the evidence above several of
// them do exactly that kind of thing. Every decision here is made on the leg's
// ADDRESS, canonicalised the way every other DEX surface in this repository
// canonicalises one (lower-case for EVM, EXACT base58 for Solana, because
// lower-casing a Solana mint produces a different mint). A leg with no address
// is UNRECOGNISED: an unidentifiable counterparty is not a safe one.
//
//   recognised_quote  the other leg is a major quote asset on that chain, by
//                     address. This is the honest "there is somewhere to sell
//                     into" case.
//   tokenised_asset   the other leg is itself one of OUR captured RWA wrapper
//                     tokens (intel_rwa_token_deployments). PAXG / XAUt is a
//                     legitimate pair between two gold wrappers and is counted.
//   unrecognised      anything else, INCLUDING a leg we could not identify.
//                     Counted separately, listed per token, never in a headline.
//
// ── WHERE THE ADDRESSES COME FROM ────────────────────────────────────────────
// No address in this file was typed from memory. There are exactly two sources:
//
//   1. CANONICAL_CONTRACTS in ../memecoin/degen-gate.ts, this repository's
//      reviewed address table for precisely these assets (it exists to catch
//      impersonators, so it is already address-first). `SHARED_QUOTES` names
//      (platform, symbol) pairs and takes the address from there. A pair that
//      table does not hold resolves to NOTHING and is simply absent from the
//      allowlist, which fails CLOSED.
//   2. `market_assets.facts.deployments`, our own catalogue rows written by the
//      daily CoinMarketCap metadata pass, resolved at CAPTURE time for the ids
//      in `QUOTE_CATALOGUE_ASSETS` and accepted only when the catalogue row's
//      own symbol still matches the one named here. That is how the stablecoins
//      reach Arbitrum and Base without an address being written down by hand.
//
// KNOWN GAP, stated rather than guessed: WETH, WBTC, cbBTC and wSOL have no
// CoinMarketCap catalogue row in this database (checked 2026-09-20), so they are
// recognised only on the chains degen-gate's table covers: Ethereum, Base and
// Solana. An ARBITRUM WETH or WBTC pool is therefore `unrecognised` today. It is
// listed and labelled, never hidden, and it UNDERSTATES depth rather than
// overstating it. To close the gap, add the pair to DEPTH_QUOTE_SUPPLEMENT with
// the address and the URL it was read from.

import { CANONICAL_CONTRACT_MAP, contractKey } from '../memecoin/degen-gate.ts'

/** The four chains the depth lane can read pools on. Named here rather than
 * imported so this module stays a pure classifier with no DEX dependency; a test
 * asserts it against CMC_DEX_NETWORKS. */
export const QUOTE_PLATFORMS = ['ethereum', 'base', 'arbitrum', 'solana'] as const
export type QuotePlatform = typeof QUOTE_PLATFORMS[number]

/** What the other side of a pool is. */
export type CounterClass = 'recognised_quote' | 'tokenised_asset' | 'unrecognised'

/** The classes whose pools a HEADLINE figure may be built from. A pool outside
 * this set is still listed, in its own group, with its own sentence. */
export const COUNTED_CLASSES: CounterClass[] = ['recognised_quote', 'tokenised_asset']

/** How a row's pools were classified. `by_counter_leg_address` is the only value
 * that means the split is real; a row captured before the lane stored leg
 * addresses carries NULL and the read reports it as unclassified rather than
 * guessing from the pair label. */
export const POOL_CLASSIFICATION = 'by_counter_leg_address'

/** Quote assets whose addresses come from the shared reviewed table. */
const SHARED_QUOTES: { platform: QuotePlatform; symbol: string }[] = [
  { platform: 'ethereum', symbol: 'USDT' }, { platform: 'ethereum', symbol: 'USDC' },
  { platform: 'ethereum', symbol: 'DAI' }, { platform: 'ethereum', symbol: 'USDe' },
  { platform: 'ethereum', symbol: 'WETH' }, { platform: 'ethereum', symbol: 'WBTC' },
  { platform: 'ethereum', symbol: 'cbBTC' },
  { platform: 'base', symbol: 'USDC' }, { platform: 'base', symbol: 'WETH' },
  { platform: 'base', symbol: 'cbBTC' },
  { platform: 'solana', symbol: 'USDC' }, { platform: 'solana', symbol: 'USDT' },
  { platform: 'solana', symbol: 'USDe' }, { platform: 'solana', symbol: 'WSOL' },
]

/** Hand-entered quote addresses. EMPTY, deliberately: every quote asset this
 * lane recognises today is carried either by the shared table above or by the
 * catalogue resolution below, so there is nothing here to get wrong. An entry
 * added later MUST carry the URL it was read from, exactly as the two sources
 * above carry theirs. */
export const DEPTH_QUOTE_SUPPLEMENT: { platform: QuotePlatform; symbol: string; address: string; source: string }[] = []

/** CoinMarketCap ids whose `market_assets.facts.deployments` the capture reads to
 * extend the allowlist onto every chain the issuer deployed to, at zero credits.
 *
 * The id and the symbol are both stated so a catalogue row that no longer names
 * this asset is REFUSED rather than trusted: the pair is verifiable at
 * coinmarketcap.com/currencies/<slug>/ and the deployments are the provider's own
 * `/v2/cryptocurrency/info` contract list, already stored by the nightly pass.
 *
 * This is what puts USDC, USDT, DAI and USDe on Arbitrum and Base into the
 * allowlist without an address being written down here. Verified against
 * production on 2026-09-20: all four ids carry `facts.deployments` (USDC 95 rows,
 * USDT 83, DAI 29, USDe 13). */
export const QUOTE_CATALOGUE_ASSETS: { cryptoId: string; symbol: string }[] = [
  { cryptoId: '825', symbol: 'USDT' },
  { cryptoId: '3408', symbol: 'USDC' },
  { cryptoId: '4943', symbol: 'DAI' },
  { cryptoId: '29470', symbol: 'USDe' },
]

/** One public on-chain account key, in the canonical form the rest of this
 * repository uses. `contractKey` is reused rather than reimplemented so a change
 * to how an address is canonicalised reaches this classifier too: it lower-cases
 * EVM and leaves Solana base58 EXACTLY as given. */
export function quoteKey(platform: unknown, address: unknown): string {
  return contractKey(platform, address)
}

export interface QuoteEntry { symbol: string; origin: 'shared_table' | 'supplement' | 'catalogue' }

/** The recognised-quote allowlist, keyed `platform:address`.
 *
 * `catalogueRows` are `market_assets` rows for `QUOTE_CATALOGUE_ASSETS`, shaped
 * `{ provider_id, symbol, facts: { deployments: [{ platformSlug, chain, address }] } }`.
 * Passing none yields the static allowlist, which is what the READ side uses:
 * a read never issues an extra query to classify a pool. */
// deno-lint-ignore no-explicit-any
export function quoteAllowlist(catalogueRows: any[] = []): Map<string, QuoteEntry> {
  const out = new Map<string, QuoteEntry>()
  // The shared table is keyed by its own chain slug, which matches ours for
  // every chain both know, so a (platform, symbol) pair it does not hold is
  // simply skipped and the allowlist is that much smaller.
  const wanted = new Set(SHARED_QUOTES.map((quote) => `${quote.platform}|${quote.symbol.toLowerCase()}`))
  for (const candidate of CANONICAL_CONTRACT_MAP.values()) {
    if (!wanted.has(`${candidate.chain}|${candidate.symbol.toLowerCase()}`)) continue
    const key = quoteKey(candidate.chain, candidate.address)
    if (key) out.set(key, { symbol: candidate.symbol, origin: 'shared_table' })
  }
  for (const extra of DEPTH_QUOTE_SUPPLEMENT) {
    const key = quoteKey(extra.platform, extra.address)
    if (key) out.set(key, { symbol: extra.symbol, origin: 'supplement' })
  }
  const byId = new Map(QUOTE_CATALOGUE_ASSETS.map((asset) => [asset.cryptoId, asset]))
  for (const row of catalogueRows || []) {
    const expected = byId.get(String(row?.provider_id ?? ''))
    // The catalogue row must still BE the asset named here. A row that has been
    // re-pointed at something else is refused, not trusted.
    if (!expected || String(row?.symbol ?? '').trim().toLowerCase() !== expected.symbol.toLowerCase()) continue
    const deployments = Array.isArray(row?.facts?.deployments) ? row.facts.deployments.slice(0, 500) : []
    for (const deployment of deployments) {
      const platform = normalisePlatform(deployment?.platformSlug ?? deployment?.platformName ?? deployment?.chain)
      if (!platform) continue
      const key = quoteKey(platform, deployment?.address)
      if (!key || !shapedForPlatform(platform, String(deployment?.address ?? ''))) continue
      if (!out.has(key)) out.set(key, { symbol: expected.symbol, origin: 'catalogue' })
    }
  }
  return out
}

/** A platform slug the depth lane can read, or null. `arbitrum-one` is the
 * provider's own spelling and is the one alias worth carrying, exactly as
 * `readableDeployment` in capture-rwa-depth.ts carries it. */
export function normalisePlatform(value: unknown): QuotePlatform | null {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
  const slug = raw === 'arbitrum-one' ? 'arbitrum' : raw === 'eth' ? 'ethereum' : raw
  return (QUOTE_PLATFORMS as readonly string[]).includes(slug) ? slug as QuotePlatform : null
}

/** Whether an address has the shape its chain requires. An address of the wrong
 * shape is not a near miss: it is a different chain's account, and admitting it
 * would let a Solana mint match an EVM allowlist entry. */
export function shapedForPlatform(platform: string, address: string): boolean {
  return platform === 'solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[0-9a-fA-F]{40}$/.test(address)
}

/** One pool leg as the lane stores it. `liqUsd` is the LEG's own reported size,
 * which the provider sometimes gives and sometimes leaves at zero. */
export interface StoredLeg { addr?: string | null; sym?: string | null; liqUsd?: number | null }

/** A stored pool, in the shape the depth lane writes. The leg fields are absent
 * on rows captured before 2026-09-20; see `poolsClassifiable`. */
export interface ClassifiablePool {
  chain?: string | null
  dex?: string | null
  pair?: string | null
  address?: string | null
  liquidityUsd?: number | null
  volume24h?: number | null
  t0?: StoredLeg | null
  t1?: StoredLeg | null
  counterClass?: CounterClass | null
  counterAddress?: string | null
  counterSymbol?: string | null
  exitLiquidityUsd?: number | null
}

const money = (value: unknown): number | null => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** Whether a set of stored pools carries leg ADDRESSES at all.
 *
 * Rows written by the first production runs carry only a `pair` label built from
 * the two symbols, and a symbol is exactly what must not be trusted. Those rows
 * are reported as unclassified rather than classified wrongly. */
export function poolsClassifiable(pools: ClassifiablePool[] = []): boolean {
  return pools.some((pool) => !!(pool?.t0?.addr || pool?.t1?.addr))
}

export interface ClassifyContext {
  /** `platform:address` of the recognised quote assets. */
  quotes: Map<string, QuoteEntry>
  /** `platform:address` of every RWA wrapper token WE have captured. */
  rwaAddresses: Set<string>
  /** `platform:address` of the SUBJECT token's own deployments, so the counter
   * leg is the one that is not the subject. */
  subjectAddresses: Set<string>
}

export interface PoolClassification {
  counterClass: CounterClass
  counterAddress: string | null
  counterSymbol: string | null
  /** The counter leg's OWN reported size, on a recognised-quote pool only. This
   * is the closest thing in the payload to "what you could take out", because it
   * is the side of the pool a seller receives. Null when the provider reported
   * nothing or zero for that leg, and null on every other class: a tokenised
   * counter leg's size is another wrapper's liquidity, not cash. */
  exitLiquidityUsd: number | null
}

/**
 * Classify one pool by the leg that is NOT the subject token.
 *
 * Which leg is the subject is decided by ADDRESS against the subject's own
 * deployments. When neither leg matches the subject (the provider sent a pool we
 * cannot place) the pool is unrecognised: guessing which side is ours would be
 * the same mistake as guessing what the other side is worth.
 */
export function classifyPool(pool: ClassifiablePool, ctx: ClassifyContext): PoolClassification {
  const platform = normalisePlatform(pool?.chain)
  const unknown: PoolClassification = { counterClass: 'unrecognised', counterAddress: null, counterSymbol: null, exitLiquidityUsd: null }
  if (!platform) return unknown
  const legs = [pool?.t0, pool?.t1]
  const keyed = legs.map((leg) => {
    const address = String(leg?.addr ?? '').trim()
    return {
      leg, address,
      key: address && shapedForPlatform(platform, address) ? quoteKey(platform, address) : '',
    }
  })
  if (!keyed.some((entry) => entry.key)) return unknown
  // The counter leg is the one that is not the subject. Both legs matching the
  // subject would be a pool of the token against itself, which is not a place to
  // sell it either.
  const subjectSide = keyed.findIndex((entry) => entry.key && ctx.subjectAddresses.has(entry.key))
  if (subjectSide < 0) return unknown
  const counter = keyed[subjectSide === 0 ? 1 : 0]
  if (!counter.key) return { ...unknown, counterSymbol: String(counter.leg?.sym ?? '').trim().slice(0, 40) || null }
  const counterSymbol = String(counter.leg?.sym ?? '').trim().slice(0, 40) || null
  const quote = ctx.quotes.get(counter.key)
  if (quote) {
    return {
      counterClass: 'recognised_quote', counterAddress: counter.address, counterSymbol,
      // Zero is not an exit size, it is the provider declining to report one for
      // that leg, so it stays absent rather than being summed as a zero.
      exitLiquidityUsd: (money(counter.leg?.liqUsd) ?? 0) > 0 ? money(counter.leg?.liqUsd) : null,
    }
  }
  if (ctx.rwaAddresses.has(counter.key)) {
    return { counterClass: 'tokenised_asset', counterAddress: counter.address, counterSymbol, exitLiquidityUsd: null }
  }
  return { counterClass: 'unrecognised', counterAddress: counter.address, counterSymbol, exitLiquidityUsd: null }
}

export interface ClassifiedTotals {
  /** Pools whose counter leg is a recognised quote or one of our own wrappers. */
  countedPools: number
  countedLiquidityPools: number
  countedLiquidityUsd: number | null
  countedVolume24hUsd: number | null
  deepestCounted: ClassifiablePool | null
  /** Pools whose counter leg we cannot value. Reported, never counted. */
  unrecognisedPools: number
  unrecognisedLiquidityUsd: number | null
  deepestUnrecognised: ClassifiablePool | null
  /** Sum of the counter legs' own reported sizes on recognised-quote pools, and
   * how many pools it was built from. Null when the provider reported none. */
  exitLiquidityUsd: number | null
  exitLiquidityPools: number
}

/** Split a classified pool list into the figures the board may print.
 *
 * Only pools that already CARRY a class are split; `classifyStoredPools` is what
 * puts one on each. A pool with no liquidity figure is counted as a pool and
 * contributes nothing to a total, exactly as `depthReading` has always done. */
export function classifiedTotals(pools: ClassifiablePool[] = []): ClassifiedTotals {
  const counted = pools.filter((pool) => COUNTED_CLASSES.includes(pool?.counterClass as CounterClass))
  const unrecognised = pools.filter((pool) => pool?.counterClass === 'unrecognised')
  const deepest = (list: ClassifiablePool[]): ClassifiablePool | null => {
    const priced = list.filter((pool) => money(pool?.liquidityUsd) != null)
    return priced.length ? priced.reduce((best, pool) => (money(pool.liquidityUsd)! > money(best.liquidityUsd)! ? pool : best)) : null
  }
  const sum = (list: ClassifiablePool[], field: 'liquidityUsd' | 'volume24h'): number | null => {
    const values = list.map((pool) => money(pool?.[field])).filter((value): value is number => value != null)
    return values.length ? values.reduce((total, value) => total + value, 0) : null
  }
  const exits = counted
    .filter((pool) => pool?.counterClass === 'recognised_quote')
    .map((pool) => money(pool?.exitLiquidityUsd)).filter((value): value is number => value != null && value > 0)
  return {
    countedPools: counted.length,
    countedLiquidityPools: counted.filter((pool) => money(pool?.liquidityUsd) != null).length,
    countedLiquidityUsd: sum(counted, 'liquidityUsd'),
    countedVolume24hUsd: sum(counted, 'volume24h'),
    deepestCounted: deepest(counted),
    unrecognisedPools: unrecognised.length,
    unrecognisedLiquidityUsd: sum(unrecognised, 'liquidityUsd'),
    deepestUnrecognised: deepest(unrecognised),
    exitLiquidityUsd: exits.length ? exits.reduce((total, value) => total + value, 0) : null,
    exitLiquidityPools: exits.length,
  }
}

/** Put a class on every pool in a list, leaving the originals untouched. Used by
 * the capture (over freshly read pools) and by the read view as a fallback for a
 * row the capture classified before these fields existed. */
export function classifyStoredPools(pools: ClassifiablePool[] = [], ctx: ClassifyContext): ClassifiablePool[] {
  return pools.map((pool) => ({ ...pool, ...classifyPool(pool, ctx) }))
}

// ── The sentences ────────────────────────────────────────────────────────────
// They live beside the classifier because the number and the sentence explaining
// it must never drift apart. The UI takes them from the payload; the locales
// carry the translated versions of the short ones.

/** Why the unrecognised group is not in the headline. Printed beside it. */
export const UNRECOGNISED_SCOPE =
  'Counted separately because the other side of the pool is a token we cannot value, so its reported USD liquidity is not something a seller could take out. CoinMarketCap values BOTH legs of a pool, so a pool against a worthless or self-priced token still reports a large figure.'

/** How the counted figures were built, and what they are not. */
export const COUNTED_SCOPE =
  'Total liquidity, the deepest pool, concentration and the exit sizes on this row are built ONLY from pools whose other leg is a major quote asset on that chain or another tokenised asset we have captured, matched by contract address and never by symbol. A pool against a token we cannot value is listed separately and is in none of those figures.'

/** What the counter-leg exit figure is, and what it is not. Named on the payload
 * whenever the figure is shown. */
export const EXIT_LIQUIDITY_SCOPE =
  'Where CoinMarketCap reports a size for the quote leg itself, that size is summed here: it is the side of the pool a seller receives, so it is the closest figure in the data to what could be taken out. The provider leaves it at zero for many pools, so this is a floor built from the pools that reported one, never the token\'s whole exit capacity, and it is still not a slippage model.'

/** A row captured before the lane stored leg addresses. Stated rather than
 * guessed: the stored pair label is two SYMBOLS, and a junk token can call
 * itself USDC, so classifying from it would be the same defect in a new place. */
export const UNCLASSIFIED_SCOPE =
  'Counter legs not classified for this capture: it was taken before the lane stored the pool legs\' contract addresses, and the stored pair label is two symbols, which a token can choose for itself. The liquidity on this row is CoinMarketCap\'s figure over every pool found, including any whose other side cannot be valued. The next daily run classifies it.'
