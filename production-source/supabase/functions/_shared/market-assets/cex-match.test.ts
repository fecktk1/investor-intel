// Tests for confidence-gated CEX matching (G1). Run:
//   deno test supabase/functions/_shared/market-assets/cex-match.test.ts

import { buildSymbolCounts, matchCexEnrichment, type CexMatchCtx } from './cex-match.ts'

function assert(c: unknown, m: string) { if (!c) throw new Error(m) }

function ctx(over: Partial<CexMatchCtx> = {}): CexMatchCtx {
  return {
    profileBySym: new Map([['PEPE', { normalized_symbol: 'PEPE', providers: ['binance'] }], ['FOO', { normalized_symbol: 'FOO' }], ['WBTC', { normalized_symbol: 'WBTC' }]]),
    mappingBySym: new Map(),
    symbolCounts: new Map([['PEPE', 1], ['FOO', 2], ['WBTC', 1]]),
    ...over,
  }
}

Deno.test('curated major, unambiguous, with profile → high', () => {
  const m = matchCexEnrichment({ normalizedSymbol: 'PEPE', providerId: 'pepe', platforms: null }, ctx())
  assert(m.confidence === 'high', `expected high, got ${m.confidence} (${m.reason})`)
  assert(!!m.profile, 'should attach profile')
})

Deno.test('ambiguous symbol with profile → low (never drives arb)', () => {
  const m = matchCexEnrichment({ normalizedSymbol: 'FOO', providerId: 'foo-token', platforms: null }, ctx())
  assert(m.confidence === 'low', `expected low, got ${m.confidence} (${m.reason})`)
})

Deno.test('no CEX profile → unknown (no coverage)', () => {
  const m = matchCexEnrichment({ normalizedSymbol: 'NOPE', providerId: 'nope', platforms: null }, ctx())
  assert(m.confidence === 'unknown', `expected unknown, got ${m.confidence}`)
  assert(m.profile === null, 'no profile expected')
})

Deno.test('wrapped/bridged base (WBTC) → low even if unambiguous', () => {
  const m = matchCexEnrichment({ normalizedSymbol: 'WBTC', providerId: 'wrapped-bitcoin', platforms: null }, ctx())
  assert(m.confidence === 'low', `expected low, got ${m.confidence} (${m.reason})`)
})

Deno.test('admin mapping → high', () => {
  const c = ctx({ mappingBySym: new Map([['FOO', { normalized_symbol: 'FOO', is_active: true, mapping_source: 'admin_override' }]]) })
  const m = matchCexEnrichment({ normalizedSymbol: 'FOO', providerId: 'foo-token', platforms: null }, c)
  assert(m.confidence === 'high', `expected high via mapping, got ${m.confidence} (${m.reason})`)
})

Deno.test('contract-address mapping match → high', () => {
  const c = ctx({ mappingBySym: new Map([['FOO', { normalized_symbol: 'FOO', is_active: true, mapping_source: 'curated', contract_address: '0xABC' }]]) })
  const m = matchCexEnrichment({ normalizedSymbol: 'FOO', providerId: 'foo-token', platforms: { ethereum: '0xabc' } }, c)
  assert(m.confidence === 'high', `expected high via contract, got ${m.confidence} (${m.reason})`)
})

Deno.test('buildSymbolCounts counts claimants', () => {
  const counts = buildSymbolCounts([{ normalizedSymbol: 'A' }, { normalizedSymbol: 'A' }, { normalizedSymbol: 'B' }, { normalizedSymbol: null }])
  assert(counts.get('A') === 2, 'A should be 2')
  assert(counts.get('B') === 1, 'B should be 1')
})
