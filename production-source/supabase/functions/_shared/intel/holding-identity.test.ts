// Tests for contract identity resolution over portfolio holdings (proposal 25).
// Run:
//   deno test --allow-all --no-check supabase/functions/_shared/intel/holding-identity.test.ts
//
// What is proved here is the honesty of the three pure functions: that an
// unverified chain is reported as unsupported rather than guessed, that a
// provider silence stays a silence, that a missing price never becomes 0, and
// that a zero count is still a row.

import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  applyBatchAnswers, canonicalAddress, cmcPlatformForChain, coverageByChain, holdingAddress,
  HOLDING_BATCH_MAX, HOLDING_RUN_LIMIT_MAX, implausibleRule, MAX_FIRST_PRICE_VALUE_USD,
  MIN_POOL_LIQUIDITY_USD, planHoldingResolution, summarizeAnswers,
  type HoldingIdentityRow,
} from './holding-identity.ts'

const BASE_TOKEN = '0x4ed4e862860bed51a9570b96d89af5e1b0efefed'
const ETH_TOKEN = '0x45804880de22913dafe09f4980848ece6ecbaf78'
const SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

const evm = (n: number) => `0x${n.toString(16).padStart(40, '0')}`

function holding(over: Partial<HoldingIdentityRow> & { id: string }): HoldingIdentityRow {
  return {
    chain: 'base', contract_address: BASE_TOKEN, quantity: 2, price_status: 'unpriced',
    is_closed: false, asset_symbol: null, name: null, ...over,
  }
}

Deno.test('coverage counts every open holding by chain, and a zero is a zero', () => {
  const rows: HoldingIdentityRow[] = [
    holding({ id: 'b1' }), holding({ id: 'b2' }), holding({ id: 'b3', price_status: 'priced' }),
    holding({ id: 'b4', price_status: 'stale' }), holding({ id: 'b5', price_status: 'estimated' }),
    holding({ id: 'n1', chain: 'bnb', contract_address: evm(11) }),
    holding({ id: 's1', chain: 'solana', contract_address: SOL_MINT, price_status: 'priced' }),
    // Closed positions are history, not coverage.
    holding({ id: 'closed', is_closed: true }),
  ]
  const { chains, totals } = coverageByChain(rows)

  eq(chains.map((c) => c.chain), ['base', 'bnb', 'solana'])
  const base = chains[0]
  eq([base.total, base.priced, base.unpriced, base.stale, base.estimated, base.resolvable], [5, 1, 2, 1, 1, 5])
  assert(base.supported)
  eq(base.reason, null)

  const bnb = chains[1]
  eq(bnb.supported, false)
  eq(bnb.reason, 'unsupported_platform')
  // An unverified chain is never resolvable, however good its address looks.
  eq(bnb.resolvable, 0)

  const solana = chains[2]
  // A chain that is fully priced still reports its zeros rather than vanishing.
  eq([solana.total, solana.priced, solana.unpriced, solana.stale, solana.estimated, solana.resolvable], [1, 1, 0, 0, 0, 1])

  eq(totals.chains, 3)
  eq(totals.total, 7)
  eq([totals.priced, totals.unpriced, totals.stale, totals.estimated], [2, 3, 1, 1])
  eq(totals.unsupported, 1)
  eq(totals.missingContract, 0)
})

Deno.test('coverage separates a missing contract from an unsupported chain', () => {
  const rows: HoldingIdentityRow[] = [
    holding({ id: 'no-address', contract_address: null, mint_or_contract: null }),
    holding({ id: 'bad-address', contract_address: 'not-an-address' }),
    // A base58 mint on an EVM chain is not an address for that chain.
    holding({ id: 'wrong-shape', chain: 'ethereum', contract_address: SOL_MINT }),
    holding({ id: 'unsupported', chain: 'optimism', contract_address: evm(7) }),
    holding({ id: 'chainless', chain: null }),
  ]
  const { chains, totals } = coverageByChain(rows)
  eq(totals.missingContract, 3)
  eq(totals.unsupported, 2) // optimism plus the null chain, which is 'unknown'
  eq(chains.find((c) => c.chain === 'unknown')?.supported, false)
  eq(chains.find((c) => c.chain === 'base')?.resolvable, 0)
})

Deno.test('the plan asks only about open unpriced/stale holdings on verified chains', () => {
  const rows: HoldingIdentityRow[] = [
    holding({ id: 'h1' }),
    holding({ id: 'h2', price_status: 'stale' }),
    holding({ id: 'skip-priced', price_status: 'priced' }),
    holding({ id: 'skip-estimated', price_status: 'estimated' }),
    holding({ id: 'skip-closed', is_closed: true }),
    holding({ id: 'skip-bnb', chain: 'bnb', contract_address: evm(3) }),
    holding({ id: 'skip-avax', chain: 'avalanche', contract_address: evm(4) }),
    holding({ id: 'skip-no-contract', contract_address: null }),
  ]
  const plan = planHoldingResolution(rows)

  // h1 and h2 share one contract: one subject, two holdings, one question.
  eq(plan.subjects.length, 1)
  eq(plan.subjects[0].holdingIds.sort(), ['h1', 'h2'])
  eq(plan.requested, 2)
  eq(plan.batchGroups, [{ platform: 'base', addresses: [BASE_TOKEN] }])
  eq(plan.priceGroups, [{ tokens: [{ platform: 'base', address: BASE_TOKEN }] }])
  eq(plan.estimatedCredits, 2)
  eq(plan.truncated, false)

  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.holdingId, s.reason]))
  eq(reasons['skip-bnb'], 'unsupported_platform')
  eq(reasons['skip-avax'], 'unsupported_platform')
  eq(reasons['skip-no-contract'], 'no_contract_address')
  // A priced, estimated or closed holding is not a skip at all: nothing about it
  // was asked, and nothing about it is reported as a failure.
  eq(plan.skipped.some((s) => s.holdingId.startsWith('skip-priced')), false)
  eq(plan.skipped.length, 3)
  eq(plan.unsupported, [{ chain: 'avalanche', count: 1 }, { chain: 'bnb', count: 1 }])
})

Deno.test('subjects chunk at 50 per platform and 50 per price batch', () => {
  const rows: HoldingIdentityRow[] = []
  for (let i = 1; i <= 60; i++) rows.push(holding({ id: `base-${i}`, contract_address: evm(i) }))
  for (let i = 1; i <= 15; i++) rows.push(holding({ id: `eth-${i}`, chain: 'ethereum', contract_address: evm(1000 + i) }))

  const plan = planHoldingResolution(rows, { limit: HOLDING_RUN_LIMIT_MAX })
  eq(plan.subjects.length, 75)
  eq(plan.requested, 75)
  // Two base groups (50 + 10) and one ethereum group; no group over the ceiling.
  eq(plan.batchGroups.map((g) => `${g.platform}:${g.addresses.length}`), ['base:50', 'base:10', 'ethereum:15'])
  assert(plan.batchGroups.every((g) => g.addresses.length <= HOLDING_BATCH_MAX))
  // A batch group never mixes platforms; a price group may, and is still bounded.
  eq(plan.priceGroups.map((g) => g.tokens.length), [50, 25])
  assert(plan.priceGroups.every((g) => g.tokens.length <= HOLDING_BATCH_MAX))
  eq(plan.estimatedCredits, 5)
})

Deno.test('the run limit cuts subjects and says so, and is itself bounded', () => {
  const rows: HoldingIdentityRow[] = []
  for (let i = 1; i <= 10; i++) rows.push(holding({ id: `h-${i}`, contract_address: evm(i) }))

  const plan = planHoldingResolution(rows, { limit: 4 })
  eq(plan.limit, 4)
  eq(plan.subjects.length, 4)
  eq(plan.requested, 4)
  eq(plan.truncated, true)
  eq(plan.skipped.length, 6)
  assert(plan.skipped.every((s) => s.reason === 'over_run_limit'))

  eq(planHoldingResolution(rows, { limit: 0 }).limit, 50)
  eq(planHoldingResolution(rows, { limit: -3 }).limit, 50)
  eq(planHoldingResolution(rows, { limit: 9999 }).limit, HOLDING_RUN_LIMIT_MAX)
  eq(planHoldingResolution(rows, {}).limit, 50)
  eq(planHoldingResolution([]).requested, 0)
  eq(planHoldingResolution([]).estimatedCredits, 0)
})

Deno.test('addresses are canonicalised the way the provider canonicalises them', () => {
  eq(cmcPlatformForChain('BASE'), 'base')
  eq(cmcPlatformForChain('eip155:8453'), 'base')
  eq(cmcPlatformForChain('solana'), 'solana')
  eq(cmcPlatformForChain('bnb'), null)
  eq(cmcPlatformForChain(null), null)
  eq(canonicalAddress('0xABCDEF0123456789012345678901234567890123', 'base'), '0xabcdef0123456789012345678901234567890123')
  eq(canonicalAddress(SOL_MINT, 'solana'), SOL_MINT)
  eq(holdingAddress({ id: 'x', contract_address: null, mint_or_contract: SOL_MINT }), SOL_MINT)
  eq(holdingAddress({ id: 'x', contract_address: '   ' , mint_or_contract: null }), null)

  // A mixed-case EVM address in the book still produces one subject, not two.
  const plan = planHoldingResolution([
    holding({ id: 'a', contract_address: BASE_TOKEN.toUpperCase().replace('0X', '0x') }),
    holding({ id: 'b', contract_address: BASE_TOKEN }),
  ])
  eq(plan.subjects.length, 1)
  eq(plan.subjects[0].address, BASE_TOKEN)
})

Deno.test('a token the provider did not return is not_found_on_provider', () => {
  const plan = planHoldingResolution([
    holding({ id: 'answered', contract_address: BASE_TOKEN }),
    holding({ id: 'silent', contract_address: evm(42) }),
    holding({ id: 'bnb', chain: 'bnb', contract_address: evm(9) }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [{ pid: 199, addr: BASE_TOKEN, n: 'Degen', sym: 'DEGEN', p: 0.0121, liqUsd: 90_000, mcap: 12_000_000 }],
    [{ pid: 199, a: BASE_TOKEN, p: 0.0121 }],
  )
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))

  eq(byId.answered.matched, true)
  eq(byId.answered.reason, 'priced')
  eq(byId.answered.symbol, 'DEGEN')
  eq(byId.answered.name, 'Degen')
  eq(byId.answered.cmcDexPrice, 0.0121)
  eq(byId.answered.priceFrom, 'dexPriceBatch')
  eq(byId.answered.value, 0.0242)

  eq(byId.silent.matched, false)
  eq(byId.silent.reason, 'not_found_on_provider')
  eq(byId.silent.cmcDexPrice, null)
  eq(byId.silent.value, null)
  eq(byId.silent.symbol, null)

  // The holding the plan could not ask about is still reported, once.
  eq(byId.bnb.reason, 'unsupported_platform')
  eq(byId.bnb.matched, false)
  eq(answers.length, 3)
})

Deno.test('a null, absent or negative price is price_unavailable, never 0', () => {
  const plan = planHoldingResolution([
    holding({ id: 'null-price', contract_address: evm(1) }),
    holding({ id: 'absent-price', contract_address: evm(2) }),
    holding({ id: 'negative-price', contract_address: evm(3) }),
    holding({ id: 'stated-zero', contract_address: evm(4) }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [
      { pid: 199, addr: evm(1), sym: 'A', n: 'Alpha', p: null },
      { pid: 199, addr: evm(2), sym: 'B', n: 'Beta' },
      { pid: 199, addr: evm(3), sym: 'C', n: 'Gamma', p: -1 },
      { pid: 199, addr: evm(4), sym: 'D', n: 'Delta', liqUsd: 40_000, mcap: 2_000_000 },
    ],
    [{ pid: 199, a: evm(4), p: 0 }],
  )
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))

  for (const id of ['null-price', 'absent-price', 'negative-price']) {
    eq(byId[id].matched, true, id)
    eq(byId[id].reason, 'price_unavailable', id)
    eq(byId[id].cmcDexPrice, null, id)
    eq(byId[id].priceFrom, null, id)
    eq(byId[id].value, null, id)
    // Identity still arrived, which is what an identity-only match means.
    assert(byId[id].symbol)
  }
  // A provider-STATED zero is a fact, not an absence: it stays a zero.
  eq(byId['stated-zero'].reason, 'priced')
  eq(byId['stated-zero'].cmcDexPrice, 0)
  eq(byId['stated-zero'].value, 0)
})

Deno.test('the identity batch price is used only when the price batch is silent', () => {
  const plan = planHoldingResolution([
    holding({ id: 'both', contract_address: evm(1) }),
    holding({ id: 'batch-only', contract_address: evm(2) }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [{ pid: 199, addr: evm(1), sym: 'A', p: 5, liqUsd: 80_000, mcap: 9_000_000 }, { pid: 199, addr: evm(2), sym: 'B', p: 7, liqUsd: 80_000, mcap: 9_000_000 }],
    [{ pid: 199, a: evm(1), p: 6 }],
  )
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))
  eq([byId.both.cmcDexPrice, byId.both.priceFrom], [6, 'dexPriceBatch'])
  eq([byId['batch-only'].cmcDexPrice, byId['batch-only'].priceFrom], [7, 'dexBatch'])
})

Deno.test('rows about somebody else, or about nothing, are never matched by position', () => {
  const plan = planHoldingResolution([holding({ id: 'h1', contract_address: BASE_TOKEN })])
  const answers = applyBatchAnswers(
    plan,
    [
      { pid: 199, addr: ETH_TOKEN, sym: 'WRONG', p: 99 },   // right chain, other token
      { pid: 1, addr: BASE_TOKEN, sym: 'WRONG', p: 99 },    // right token, other chain
      { pid: 777, addr: BASE_TOKEN, sym: 'WRONG', p: 99 },  // unverified platform id
      { pid: 199, addr: 'nonsense', sym: 'WRONG', p: 99 },
      null, 'not a row', [1, 2, 3],
    ],
    null,
  )
  eq(answers.length, 1)
  eq(answers[0].reason, 'not_found_on_provider')
  eq(answers[0].symbol, null)
  eq(answers[0].cmcDexPrice, null)
})

Deno.test('solana subjects keep base58 case and match their own platform id', () => {
  const plan = planHoldingResolution([
    holding({ id: 'sol', chain: 'solana', contract_address: SOL_MINT, mint_or_contract: null, quantity: 3 }),
  ])
  eq(plan.batchGroups, [{ platform: 'solana', addresses: [SOL_MINT] }])
  const answers = applyBatchAnswers(plan, [{ pid: 16, addr: SOL_MINT, sym: 'USDC', n: 'USD Coin', p: 1, liqUsd: 5_000_000, mcap: 40_000_000_000 }], [{ pid: 16, a: SOL_MINT, p: 1 }])
  eq(answers[0].reason, 'priced')
  eq(answers[0].value, 3)
  eq(answers[0].address, SOL_MINT)
})

Deno.test('the summary counts every outcome exactly once', () => {
  const plan = planHoldingResolution([
    holding({ id: 'priced', contract_address: evm(1) }),
    holding({ id: 'identity', contract_address: evm(2) }),
    holding({ id: 'silent', contract_address: evm(3) }),
    holding({ id: 'bnb', chain: 'bnb', contract_address: evm(4) }),
    holding({ id: 'no-contract', contract_address: null }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [{ pid: 199, addr: evm(1), sym: 'A', p: 2, liqUsd: 60_000, mcap: 7_000_000 }, { pid: 199, addr: evm(2), sym: 'B', p: null }],
    [{ pid: 199, a: evm(1), p: 2 }],
  )
  const summary = summarizeAnswers(answers)
  eq(summary, { matched: 2, priced: 1, identityOnly: 1, implausible: 0, notFound: 1, unsupported: 1, missingContract: 1, overLimit: 0 })
  eq(answers.length, 5)
  eq(summary.priced + summary.identityOnly + summary.implausible + summary.notFound + summary.unsupported + summary.missingContract + summary.overLimit, answers.length)
})

// ── The plausibility gate (added after the first live run) ──

Deno.test('the STREAMGPT case: a value above the token\'s own market cap is refused', () => {
  // The live run of 2026-09-15 wrote $3,723,685 a token for a Base holding and
  // valued the position at $372.4M. The token's reported market cap was a tiny
  // fraction of that: a holding cannot be worth more than the whole token.
  const plan = planHoldingResolution([
    holding({ id: 'streamgpt', contract_address: BASE_TOKEN, quantity: 100, asset_symbol: 'STREAMGPT' }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [{ pid: 199, addr: BASE_TOKEN, n: 'StreamGPT', sym: 'STREAMGPT', p: 3_723_685, liqUsd: 42_000, mcap: 1_800_000 }],
    [{ pid: 199, a: BASE_TOKEN, p: 3_723_685 }],
  )
  const answer = answers[0]
  eq(answer.reason, 'price_implausible')
  eq(answer.matched, true, 'the identity was still resolved')
  eq(answer.symbol, 'STREAMGPT')
  // The number is reported so a reader can see exactly what was refused…
  eq(answer.cmcDexPrice, 3_723_685)
  eq(answer.implausible, {
    price: 3_723_685, liquidityUsd: 42_000, marketCapUsd: 1_800_000,
    impliedValue: 372_368_500, rule: 'value_exceeds_market_cap',
  })
  // …and `value` is null, so nothing downstream can add $372.4M to a portfolio.
  eq(answer.value, null)
  eq(summarizeAnswers(answers).priced, 0)
  eq(summarizeAnswers(answers).implausible, 1)
})

Deno.test('a thin or unreported pool is not a market', () => {
  const plan = planHoldingResolution([
    holding({ id: 'thin', contract_address: evm(1), quantity: 1 }),
    holding({ id: 'no-liquidity', contract_address: evm(2), quantity: 1 }),
    holding({ id: 'negative', contract_address: evm(3), quantity: 1 }),
    holding({ id: 'at-floor', contract_address: evm(4), quantity: 1 }),
  ])
  const answers = applyBatchAnswers(
    plan,
    [
      { pid: 199, addr: evm(1), sym: 'THIN', p: 12, liqUsd: 999.99, mcap: 5_000_000 },
      { pid: 199, addr: evm(2), sym: 'NONE', p: 12, mcap: 5_000_000 },
      { pid: 199, addr: evm(3), sym: 'NEG', p: 12, liqUsd: -5, mcap: 5_000_000 },
      { pid: 199, addr: evm(4), sym: 'OK', p: 12, liqUsd: 1000, mcap: 5_000_000 },
    ],
    [],
  )
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))
  eq(byId.thin.reason, 'price_implausible')
  eq(byId.thin.implausible?.rule, 'liquidity_below_floor')
  eq(byId['no-liquidity'].reason, 'price_implausible')
  eq(byId['no-liquidity'].implausible?.rule, 'liquidity_unknown')
  eq(byId['no-liquidity'].liquidityUsd, null)
  // A negative liquidity is an unusable answer, not a small one.
  eq(byId.negative.implausible?.rule, 'liquidity_unknown')
  // Exactly at the floor is inside it: MIN_POOL_LIQUIDITY_USD is a minimum.
  eq(byId['at-floor'].reason, 'priced')
  eq(byId['at-floor'].value, 12)
  eq([MIN_POOL_LIQUIDITY_USD, MAX_FIRST_PRICE_VALUE_USD], [1_000, 1_000_000])
})

Deno.test('the first-price ceiling applies to a previously unpriced holding only', () => {
  const rows = [
    holding({ id: 'first', contract_address: evm(1), quantity: 200_000, price_status: 'unpriced' }),
    holding({ id: 'refresh', contract_address: evm(2), quantity: 200_000, price_status: 'stale' }),
  ]
  const plan = planHoldingResolution(rows)
  const batch = [
    { pid: 199, addr: evm(1), sym: 'BIG', p: 10, liqUsd: 500_000 },
    { pid: 199, addr: evm(2), sym: 'BIG', p: 10, liqUsd: 500_000 },
  ]
  const byId = Object.fromEntries(applyBatchAnswers(plan, batch, []).map((a) => [a.holdingId, a]))

  // $2,000,000 implied on a first pricing: refused, and the ceiling is named.
  eq(byId.first.reason, 'price_implausible')
  eq(byId.first.implausible?.rule, 'value_exceeds_first_price_ceiling')
  eq(byId.first.implausible?.impliedValue, 2_000_000)
  eq(byId.first.value, null)
  // The same number on a holding that already had a price is a refresh, and a
  // genuine seven-figure position is allowed to stay one.
  eq(byId.refresh.reason, 'priced')
  eq(byId.refresh.value, 2_000_000)

  // Exactly at the ceiling is allowed; a cent over is not.
  const at = planHoldingResolution([holding({ id: 'at', contract_address: evm(3), quantity: 100_000 })])
  eq(applyBatchAnswers(at, [{ pid: 199, addr: evm(3), sym: 'AT', p: 10, liqUsd: 500_000 }], [])[0].reason, 'priced')
  const over = planHoldingResolution([holding({ id: 'over', contract_address: evm(3), quantity: 100_001 })])
  eq(applyBatchAnswers(over, [{ pid: 199, addr: evm(3), sym: 'OVER', p: 10, liqUsd: 500_000 }], [])[0].reason, 'price_implausible')
})

Deno.test('the gate reads liquidity and market cap from either batch', () => {
  const plan = planHoldingResolution([
    holding({ id: 'from-price-batch', contract_address: evm(1), quantity: 10 }),
    holding({ id: 'price-batch-cap', contract_address: evm(2), quantity: 10 }),
  ])
  const answers = applyBatchAnswers(
    plan,
    // The identity batch says nothing about either magnitude.
    [{ pid: 199, addr: evm(1), sym: 'A' }, { pid: 199, addr: evm(2), sym: 'B' }],
    [
      { pid: 199, a: evm(1), p: 4, l: 250_000, mc: 9_000_000 },
      { pid: 199, a: evm(2), p: 4, l: 250_000, mc: 30 },
    ],
  )
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))
  eq(byId['from-price-batch'].reason, 'priced')
  eq([byId['from-price-batch'].liquidityUsd, byId['from-price-batch'].marketCapUsd], [250_000, 9_000_000])
  // $40 of a token whose whole market cap is $30.
  eq(byId['price-batch-cap'].reason, 'price_implausible')
  eq(byId['price-batch-cap'].implausible?.rule, 'value_exceeds_market_cap')
})

Deno.test('a market cap of zero or absence does not refuse on its own', () => {
  const plan = planHoldingResolution([
    holding({ id: 'zero-cap', contract_address: evm(1), quantity: 1 }),
    holding({ id: 'no-cap', contract_address: evm(2), quantity: 1 }),
    holding({ id: 'no-quantity', contract_address: evm(3), quantity: null }),
  ])
  const byId = Object.fromEntries(applyBatchAnswers(plan, [
    { pid: 199, addr: evm(1), sym: 'A', p: 5, liqUsd: 20_000, mcap: 0 },
    { pid: 199, addr: evm(2), sym: 'B', p: 5, liqUsd: 20_000 },
    { pid: 199, addr: evm(3), sym: 'C', p: 5, liqUsd: 20_000, mcap: 1 },
  ], []).map((a) => [a.holdingId, a]))
  // A reported market cap of 0 is another absence, not a ceiling of zero.
  eq(byId['zero-cap'].reason, 'priced')
  eq(byId['no-cap'].reason, 'priced')
  // Without a quantity there is no implied value to test; liquidity still ruled.
  eq(byId['no-quantity'].reason, 'priced')
  eq(byId['no-quantity'].value, null)
})

Deno.test('implausibleRule evaluates its three gates in order', () => {
  // Liquidity is decided first: without a market the other tests compare one
  // provider aggregate against another.
  eq(implausibleRule(1, 10_000_000, null, 5, true), 'liquidity_unknown')
  eq(implausibleRule(1, 10_000_000, 10, 5, true), 'liquidity_below_floor')
  eq(implausibleRule(1, 10_000_000, 50_000, 5, false), 'value_exceeds_market_cap')
  eq(implausibleRule(1, 10_000_000, 50_000, null, true), 'value_exceeds_first_price_ceiling')
  eq(implausibleRule(1, 10_000_000, 50_000, null, false), null)
  eq(implausibleRule(0, 0, 50_000, 1_000, true), null, 'a stated zero on a liquid pool is still a zero')
  eq(implausibleRule(1, null, 50_000, 1, true), null, 'no implied value, nothing to compare')
})

Deno.test('a quantity that is not a number never produces a value', () => {
  const plan = planHoldingResolution([
    holding({ id: 'nan', contract_address: evm(1), quantity: 'abc' }),
    holding({ id: 'null', contract_address: evm(2), quantity: null }),
    holding({ id: 'string', contract_address: evm(3), quantity: '4' }),
  ])
  const answers = applyBatchAnswers(plan, [], [
    { pid: 199, a: evm(1), p: 3, l: 70_000 }, { pid: 199, a: evm(2), p: 3, l: 70_000 }, { pid: 199, a: evm(3), p: 3, l: 70_000, mc: 500_000 },
  ])
  const byId = Object.fromEntries(answers.map((a) => [a.holdingId, a]))
  eq(byId.nan.value, null)
  eq(byId.null.value, null)
  eq(byId.string.value, 12)
})
