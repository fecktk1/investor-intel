import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  COUNTED_SCOPE, POOL_CLASSIFICATION, QUOTE_CATALOGUE_ASSETS, QUOTE_PLATFORMS, UNCLASSIFIED_SCOPE, UNRECOGNISED_SCOPE,
  classifiedTotals, classifyPool, classifyStoredPools, normalisePlatform, poolsClassifiable,
  quoteAllowlist, quoteKey, shapedForPlatform,
} from './rwa-counter-leg.ts'
import type { ClassifiablePool, ClassifyContext } from './rwa-counter-leg.ts'
import { CMC_DEX_NETWORKS } from '../market-assets/cmc-dex.ts'

// ── The real addresses these cases turn on ───────────────────────────────────
// Every one is read from production on 2026-09-20: the four RWA tokens from
// intel_rwa_token_deployments, the quote assets from CANONICAL_CONTRACTS in
// ../memecoin/degen-gate.ts and from market_assets.facts.deployments. The two
// junk counterparties (GOLDGR and `u`) had no address stored at all, which is
// the whole reason this module exists, so they carry placeholders of the right
// shape: the classifier's answer for them depends only on their NOT being in the
// allowlist, never on the particular hex.
const XAUT = '0x68749665ff8d2d112fa859aa293f07a622782f38'
const PAXG = '0x45804880de22913dafe09f4980848ece6ecbaf78'
const SLVON = '0xf3e4872e6a4cf365888d93b6146a2baa7348f1a4'
const USDC_ETH = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7'
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831'
const NVDAX_SOL = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const WSOL = 'So11111111111111111111111111111111111111112'
const GOLDGR = '0x' + '1'.repeat(40)
const U_TOKEN = '0x' + '2'.repeat(40)
const FAKE_USDC = '0x' + '3'.repeat(40)

/** The catalogue rows the capture reads to extend the allowlist onto Arbitrum
 * and Base, in the shape market_assets holds them. */
const catalogueRows = [
  { provider_id: '3408', symbol: 'USDC', facts: { deployments: [
    { platformSlug: 'arbitrum', chain: 'arbitrum', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    { platformSlug: 'polygon', chain: 'polygon', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' },
  ] } },
]

const ctxFor = (subject: string[], rwa: string[] = [], rows: Record<string, unknown>[] = []): ClassifyContext => ({
  quotes: quoteAllowlist(rows),
  rwaAddresses: new Set(rwa),
  subjectAddresses: new Set(subject),
})

const pool = (over: Partial<ClassifiablePool> = {}): ClassifiablePool => ({
  chain: 'ethereum', dex: 'Uniswap v3 (Ethereum)', pair: null, address: '0x' + 'f'.repeat(40),
  liquidityUsd: 1_000, volume24h: 0, t0: null, t1: null, ...over,
})

// ── The allowlist ────────────────────────────────────────────────────────────

Deno.test('the platforms are exactly the chains the depth lane can read pools on', () => {
  eq([...QUOTE_PLATFORMS].sort(), CMC_DEX_NETWORKS.map((n) => n.platform).sort())
})

Deno.test('the allowlist carries the shared reviewed addresses and nothing invented', () => {
  const quotes = quoteAllowlist()
  eq(quotes.get(quoteKey('ethereum', USDC_ETH))?.symbol, 'USDC')
  eq(quotes.get(quoteKey('ethereum', USDT_ETH))?.symbol, 'USDT')
  eq(quotes.get(quoteKey('solana', USDC_SOL))?.symbol, 'USDC')
  eq(quotes.get(quoteKey('solana', WSOL))?.symbol, 'WSOL')
  // Every entry came from a table in this repository, never from this file.
  for (const entry of quotes.values()) assert(entry.origin === 'shared_table' || entry.origin === 'supplement')
  // A chain the depth lane cannot read is never in the allowlist, whatever the
  // shared table holds for it: a BNB Chain pool is not a pool this lane saw.
  for (const key of quotes.keys()) assert((QUOTE_PLATFORMS as readonly string[]).includes(key.split(':')[0]), key)
})

Deno.test('catalogue rows extend the allowlist onto Arbitrum without an address being written here', () => {
  const bare = quoteAllowlist()
  eq(bare.has(quoteKey('arbitrum', USDC_ARB)), false)
  const extended = quoteAllowlist(catalogueRows)
  eq(extended.get(quoteKey('arbitrum', USDC_ARB))?.symbol, 'USDC')
  eq(extended.get(quoteKey('arbitrum', USDC_ARB))?.origin, 'catalogue')
  // A deployment on a chain this lane cannot read pools on is not admitted.
  eq(extended.has(quoteKey('polygon', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359')), false)
})

Deno.test('a catalogue row that no longer names the asset is refused, not trusted', () => {
  const hijacked = [{ provider_id: '3408', symbol: 'NOTUSDC', facts: { deployments: [
    { platformSlug: 'arbitrum', chain: 'arbitrum', address: USDC_ARB },
  ] } }]
  eq(quoteAllowlist(hijacked).has(quoteKey('arbitrum', USDC_ARB)), false)
  // And an id nobody asked for cannot add itself.
  const stranger = [{ provider_id: '999999', symbol: 'USDC', facts: { deployments: [
    { platformSlug: 'ethereum', chain: 'ethereum', address: FAKE_USDC },
  ] } }]
  eq(quoteAllowlist(stranger).has(quoteKey('ethereum', FAKE_USDC)), false)
  eq(QUOTE_CATALOGUE_ASSETS.some((asset) => asset.cryptoId === '999999'), false)
})

Deno.test('addresses are canonicalised per chain: EVM case-insensitive, Solana case-EXACT', () => {
  eq(quoteKey('ethereum', USDC_ETH.toUpperCase().replace('0X', '0x')), quoteKey('ethereum', USDC_ETH))
  // Lower-casing a base58 mint produces a DIFFERENT mint, so it must not match.
  assert(quoteKey('solana', USDC_SOL) !== quoteKey('solana', USDC_SOL.toLowerCase()))
  assert(shapedForPlatform('ethereum', USDC_ETH))
  assert(!shapedForPlatform('ethereum', USDC_SOL))
  assert(shapedForPlatform('solana', USDC_SOL))
  assert(!shapedForPlatform('solana', USDC_ETH))
  eq(normalisePlatform('arbitrum-one'), 'arbitrum')
  eq(normalisePlatform('polygon'), null)
})

// ── The two production defects ───────────────────────────────────────────────

Deno.test('PRODUCTION 2026-09-20: XAUt / GOLDGR is unrecognised and leaves every headline', () => {
  const ctx = ctxFor([quoteKey('ethereum', XAUT)], [quoteKey('ethereum', PAXG), quoteKey('ethereum', XAUT)])
  // The real row: $16,488,627 of reported liquidity on $812 of daily volume,
  // which was 31 percent of XAUt's $52.8M headline.
  const goldgr = pool({
    dex: 'PancakeSwap v3 (Ethereum)', pair: 'XAUt / GOLDGR', liquidityUsd: 16_488_627.15, volume24h: 812.73,
    t0: { addr: XAUT, sym: 'XAUt', liqUsd: 0 }, t1: { addr: GOLDGR, sym: 'GOLDGR', liqUsd: 0 },
  })
  const classified = classifyPool(goldgr, ctx)
  eq(classified.counterClass, 'unrecognised')
  eq(classified.counterSymbol, 'GOLDGR')
  eq(classified.counterAddress, GOLDGR)
  eq(classified.exitLiquidityUsd, null)

  // PAXG / XAUt is a pair between two tokenised golds and DOES count.
  const paxg = pool({
    pair: 'PAXG / XAUt', liquidityUsd: 6_151_268.12, volume24h: 644_924.06,
    t0: { addr: PAXG, sym: 'PAXG', liqUsd: null }, t1: { addr: XAUT, sym: 'XAUt', liqUsd: null },
  })
  eq(classifyPool(paxg, ctx).counterClass, 'tokenised_asset')

  // XAUt / USDC is the honest case, and the USDC leg's own size is the exit one.
  const usdc = pool({
    pair: 'XAUt / USDC', liquidityUsd: 3_652_423.03, volume24h: 1.07,
    t0: { addr: XAUT, sym: 'XAUt', liqUsd: null }, t1: { addr: USDC_ETH, sym: 'USDC', liqUsd: 1_811_000 },
  })
  const honest = classifyPool(usdc, ctx)
  eq(honest.counterClass, 'recognised_quote')
  eq(honest.exitLiquidityUsd, 1_811_000)

  const totals = classifiedTotals(classifyStoredPools([goldgr, paxg, usdc], ctx))
  eq(totals.countedPools, 2)
  eq(totals.unrecognisedPools, 1)
  eq(Math.round(totals.countedLiquidityUsd as number), 9_803_691)
  eq(Math.round(totals.unrecognisedLiquidityUsd as number), 16_488_627)
  // The deepest COUNTED pool is PAXG / XAUt, not the GOLDGR pool.
  eq(totals.deepestCounted?.pair, 'PAXG / XAUt')
  eq(totals.deepestUnrecognised?.pair, 'XAUt / GOLDGR')
  eq(totals.exitLiquidityUsd, 1_811_000)
  eq(totals.exitLiquidityPools, 1)
})

Deno.test('PRODUCTION 2026-09-20: SLVon\'s $10.4M `u` pool leaves, its $0.56M USDC pool stays', () => {
  const ctx = ctxFor([quoteKey('ethereum', SLVON)], [quoteKey('ethereum', SLVON)])
  const junk = pool({
    pair: 'u / SLVon', liquidityUsd: 10_368_048.84, volume24h: 0,
    t0: { addr: U_TOKEN, sym: 'u', liqUsd: 0 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 },
  })
  const real = pool({
    pair: 'USDC / SLVon', liquidityUsd: 561_554.08, volume24h: 1_198.32,
    t0: { addr: USDC_ETH, sym: 'USDC', liqUsd: 0 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 },
  })
  const totals = classifiedTotals(classifyStoredPools([junk, real], ctx))
  eq(totals.countedPools, 1)
  eq(Math.round(totals.countedLiquidityUsd as number), 561_554)
  eq(totals.deepestCounted?.pair, 'USDC / SLVon')
  // The provider reports zero for both legs of both pools, so there is NO exit
  // figure at all. Zero is the provider declining to report, not an exit size.
  eq(totals.exitLiquidityUsd, null)
  eq(totals.exitLiquidityPools, 0)
})

// ── The attacks the classifier has to refuse ─────────────────────────────────

Deno.test('a junk token calling itself USDC is unrecognised: the ADDRESS decides', () => {
  const ctx = ctxFor([quoteKey('ethereum', SLVON)])
  const spoof = pool({
    pair: 'USDC / SLVon', liquidityUsd: 9_000_000,
    t0: { addr: FAKE_USDC, sym: 'USDC', liqUsd: 9_000_000 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 },
  })
  const classified = classifyPool(spoof, ctx)
  eq(classified.counterClass, 'unrecognised')
  // The symbol is still REPORTED, so the excluded group can be read, but it
  // bought the pool nothing, and the leg's own size is not an exit size.
  eq(classified.counterSymbol, 'USDC')
  eq(classified.exitLiquidityUsd, null)
})

Deno.test('a Solana leg matches only case-exactly, and a real wSOL pool counts', () => {
  const ctx = ctxFor([quoteKey('solana', NVDAX_SOL)])
  const real = pool({
    chain: 'solana', dex: 'Raydium (CLMM)', pair: 'wSOL / NVDAx', liquidityUsd: 154_095.26, volume24h: 208_049.39,
    t0: { addr: WSOL, sym: 'wSOL', liqUsd: 77_000 }, t1: { addr: NVDAX_SOL, sym: 'NVDAx', liqUsd: 0 },
  })
  eq(classifyPool(real, ctx).counterClass, 'recognised_quote')
  eq(classifyPool(real, ctx).exitLiquidityUsd, 77_000)
  // The same mint lower-cased is a different mint and is not in the allowlist.
  const lowered = pool({ ...real, t0: { addr: WSOL.toLowerCase(), sym: 'wSOL', liqUsd: 77_000 } })
  eq(classifyPool(lowered, ctx).counterClass, 'unrecognised')
  // A USDC pool on Solana reached by the subject's Solana deployment counts.
  const usdc = pool({
    chain: 'solana', pair: 'USDC / NVDAx', liquidityUsd: 2_159_717.51, volume24h: 1_460_545.71,
    t0: { addr: USDC_SOL, sym: 'USDC', liqUsd: null }, t1: { addr: NVDAX_SOL, sym: 'NVDAx', liqUsd: null },
  })
  eq(classifyPool(usdc, ctx).counterClass, 'recognised_quote')
})

Deno.test('a pool neither of whose legs is the subject is unrecognised, never guessed at', () => {
  const ctx = ctxFor([quoteKey('ethereum', XAUT)])
  const stray = pool({
    pair: 'USDC / PAXG', t0: { addr: USDC_ETH, sym: 'USDC', liqUsd: 5_000 }, t1: { addr: PAXG, sym: 'PAXG', liqUsd: 0 },
  })
  eq(classifyPool(stray, ctx).counterClass, 'unrecognised')
})

Deno.test('a leg with no address, or on a chain we cannot read, is unrecognised', () => {
  const ctx = ctxFor([quoteKey('ethereum', XAUT)])
  eq(classifyPool(pool({ t0: { addr: XAUT, sym: 'XAUt', liqUsd: 0 }, t1: { addr: null, sym: 'USDC', liqUsd: 0 } }), ctx).counterClass, 'unrecognised')
  eq(classifyPool(pool({ chain: 'polygon', t0: { addr: XAUT, sym: 'XAUt', liqUsd: 0 }, t1: { addr: USDC_ETH, sym: 'USDC', liqUsd: 0 } }), ctx).counterClass, 'unrecognised')
  // A leg whose address is shaped for ANOTHER chain cannot slip through either.
  eq(classifyPool(pool({ t0: { addr: XAUT, sym: 'XAUt', liqUsd: 0 }, t1: { addr: USDC_SOL, sym: 'USDC', liqUsd: 0 } }), ctx).counterClass, 'unrecognised')
})

// ── Rows captured before the legs were stored ────────────────────────────────

Deno.test('a row with no leg addresses is NOT classifiable and is never guessed from its pair label', () => {
  // Exactly the shape production held on 2026-09-20: six keys, no legs.
  const legacy = [{
    chain: 'ethereum', dex: 'PancakeSwap v3 (Ethereum)', pair: 'XAUt / GOLDGR',
    address: '0x0c592152111098ac7e5c9c0b007bb2e7985d7542',
    liquidityUsd: 16_488_627.148169847, volume24h: 812.7336969945333,
  }]
  eq(poolsClassifiable(legacy), false)
  // Classifying it anyway produces unrecognised for everything, which is why the
  // read view must not run it: the row is reported as unclassified instead.
  const forced = classifyStoredPools(legacy, ctxFor([quoteKey('ethereum', XAUT)]))
  eq(forced[0].counterClass, 'unrecognised')
  assert(UNCLASSIFIED_SCOPE.includes('not classified for this capture'))
})

Deno.test('one leg address anywhere in the list makes the row classifiable', () => {
  eq(poolsClassifiable([
    { chain: 'ethereum', pair: 'a / b' },
    { chain: 'ethereum', pair: 'c / d', t1: { addr: USDC_ETH, sym: 'USDC', liqUsd: 0 } },
  ]), true)
})

// ── The totals ───────────────────────────────────────────────────────────────

Deno.test('a pool with no reported size is counted as a pool and adds nothing to a total', () => {
  const ctx = ctxFor([quoteKey('ethereum', SLVON)])
  const priced = pool({ liquidityUsd: 500, volume24h: 10, t0: { addr: USDC_ETH, sym: 'USDC', liqUsd: 0 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 } })
  const unpriced = pool({ address: '0x' + 'e'.repeat(40), liquidityUsd: null, volume24h: 40, t0: { addr: USDT_ETH, sym: 'USDT', liqUsd: 0 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 } })
  const totals = classifiedTotals(classifyStoredPools([priced, unpriced], ctx))
  eq(totals.countedPools, 2)
  eq(totals.countedLiquidityPools, 1)
  eq(totals.countedLiquidityUsd, 500)
  eq(totals.countedVolume24hUsd, 50)
})

Deno.test('a token whose only pools are unrecognised has zero counted, not a null reading', () => {
  const ctx = ctxFor([quoteKey('ethereum', SLVON)])
  const totals = classifiedTotals(classifyStoredPools([
    pool({ pair: 'u / SLVon', liquidityUsd: 10_368_048.84, t0: { addr: U_TOKEN, sym: 'u', liqUsd: 0 }, t1: { addr: SLVON, sym: 'SLVon', liqUsd: 0 } }),
  ], ctx))
  eq(totals.countedPools, 0)
  eq(totals.countedLiquidityUsd, null)
  eq(totals.deepestCounted, null)
  eq(totals.unrecognisedPools, 1)
})

Deno.test('the scope sentences say which figures are which, in words', () => {
  eq(POOL_CLASSIFICATION, 'by_counter_leg_address')
  assert(COUNTED_SCOPE.includes('contract address'))
  assert(UNRECOGNISED_SCOPE.includes('a seller could take out'))
  assert(UNRECOGNISED_SCOPE.includes('BOTH legs'))
})
