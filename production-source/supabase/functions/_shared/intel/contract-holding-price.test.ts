// The free-DEX holdings pass. Nothing here contacts a provider: the contract
// identity builder is injected, exactly as the asset page's own path allows.

import { assertEquals as eq } from 'jsr:@std/assert@1'
import {
  CONTRACT_PRICE_MAX_CONTRACTS, priceContractHoldings, summarizeContractPrices,
} from './contract-holding-price.ts'

const FORGE = '2wqw81F24mxBsQTAvKFAufzmzPZVnq29CJqftekforgE'

/** What `buildContractMarketAsset` actually returned for FORGE on 2026-09-21. */
const forgeRow = {
  source_provider: 'contract', provider_id: `solana:${FORGE}`, symbol: 'FORGE', name: 'TheContentForge',
  current_price: 0.0005327, market_cap: 532_751, source_label: 'DEX Screener',
  as_of: '2026-09-21T17:11:48.922Z',
  contract: {
    chain: 'solana', address: FORGE, decimals: null, pairAddress: 'B5V5SkCVaFp6z7tRShg3Lq2dWdPjEpjJXfYw5sAXc6zk',
    dexId: 'meteora', liquidityUsd: 59_367.54,
    sources: [{ provider: 'dexscreener', state: 'available', observedAt: '2026-09-21T17:11:48.922Z', reason: null }],
  },
}

// deno-lint-ignore no-explicit-any
function builder(rows: Record<string, any>) {
  const calls: string[] = []
  // deno-lint-ignore no-explicit-any
  const build: any = (_admin: unknown, chain: string, address: string) => {
    calls.push(`${chain}:${address}`)
    return Promise.resolve(rows[`${chain}:${address}`] ?? null)
  }
  return { calls, build }
}

const request = (over: Record<string, unknown> = {}) => ({
  holdingId: 'h1', chain: 'solana', address: FORGE, quantity: 1000, wasUnpriced: true, ...over,
})

Deno.test('a mint the catalogue does not know is priced, with its source and its time', async () => {
  const { calls, build } = builder({ [`solana:${FORGE}`]: forgeRow })
  const answers = await priceContractHoldings({}, [request()], {}, { build })
  eq(calls, [`solana:${FORGE}`])
  eq(answers.length, 1)
  eq(answers[0].reason, 'priced')
  eq(answers[0].price, 0.0005327)
  eq(answers[0].value, 0.5327)
  eq(answers[0].symbol, 'FORGE')
  eq(answers[0].sourceLabel, 'DEX Screener')
  eq(answers[0].provider, 'dexscreener')
  eq(answers[0].observedAt, '2026-09-21T17:11:48.922Z')
  eq(answers[0].liquidityUsd, 59_367.54)
  eq(summarizeContractPrices(answers).priced, 1)
})

Deno.test('two holdings of the same mint cost one read', async () => {
  const { calls, build } = builder({ [`solana:${FORGE}`]: forgeRow })
  const answers = await priceContractHoldings({}, [request(), request({ holdingId: 'h2', quantity: 5 })], {}, { build })
  eq(calls.length, 1)
  eq(answers.map((a) => a.holdingId), ['h1', 'h2'])
  eq(answers.map((a) => a.value), [0.5327, 0.0026635])
})

Deno.test('the plausibility gate refuses the same prices the paid pass refuses', async () => {
  const noLiquidity = { ...forgeRow, contract: { ...forgeRow.contract, liquidityUsd: null } }
  const thinPool = { ...forgeRow, contract: { ...forgeRow.contract, liquidityUsd: 12 } }
  // 10,000,000,000 x $0.0005327 is $5.3m: more than the token's own market cap.
  const cases: [Record<string, unknown>, unknown, string][] = [
    [noLiquidity, request(), 'liquidity_unknown'],
    [thinPool, request(), 'liquidity_below_floor'],
    [forgeRow, request({ quantity: 10_000_000_000 }), 'value_exceeds_market_cap'],
  ]
  for (const [row, input, rule] of cases) {
    const { build } = builder({ [`solana:${FORGE}`]: row })
    // deno-lint-ignore no-explicit-any
    const answers = await priceContractHoldings({}, [input as any], {}, { build })
    eq(answers[0].reason, 'price_implausible', rule)
    eq(answers[0].implausible?.rule, rule)
    eq(answers[0].price, null, 'a refused price is never returned as a price')
  }
})

Deno.test('a source that says nothing leaves the holding unpriced, in words', async () => {
  const silent = { ...forgeRow, current_price: null }
  for (const row of [null, silent]) {
    const { build } = builder(row ? { [`solana:${FORGE}`]: row } : {})
    const answers = await priceContractHoldings({}, [request()], {}, { build })
    eq(answers[0].reason, 'price_unavailable')
    eq(answers[0].price, null)
    eq(answers[0].value, null)
  }
})

Deno.test('a chain no free DEX reader covers is named as such and never read', async () => {
  const { calls, build } = builder({})
  const answers = await priceContractHoldings({}, [
    request({ holdingId: 'h1', chain: 'bitcoin', address: 'bc1qxyz' }),
    request({ holdingId: 'h2', chain: '', address: FORGE }),
    request({ holdingId: 'h3', chain: 'solana', address: '' }),
  ], {}, { build })
  eq(calls, [])
  eq(answers.map((a) => a.reason), ['chain_not_supported', 'chain_not_supported', 'chain_not_supported'])
  eq(summarizeContractPrices(answers).unsupported, 3)
})

Deno.test('a long book is cut at the run limit and says which rows were deferred', async () => {
  const rows: Record<string, unknown> = {}
  const requests = []
  for (let i = 0; i < CONTRACT_PRICE_MAX_CONTRACTS + 3; i++) {
    const address = `${FORGE.slice(0, 40)}${String(i).padStart(4, '0')}`
    rows[`solana:${address}`] = forgeRow
    requests.push(request({ holdingId: `h${i}`, address }))
  }
  const { calls, build } = builder(rows)
  const answers = await priceContractHoldings({}, requests, {}, { build })
  eq(calls.length, CONTRACT_PRICE_MAX_CONTRACTS)
  const summary = summarizeContractPrices(answers)
  eq(summary.priced, CONTRACT_PRICE_MAX_CONTRACTS)
  eq(summary.deferred, 3)
})

Deno.test('a builder that throws is a silence, never a failed run', async () => {
  // deno-lint-ignore no-explicit-any
  const build: any = () => Promise.reject(new Error('dexscreener down'))
  const answers = await priceContractHoldings({}, [request()], {}, { build })
  eq(answers[0].reason, 'price_unavailable')
  eq(answers[0].sourceLabel, null)
})
