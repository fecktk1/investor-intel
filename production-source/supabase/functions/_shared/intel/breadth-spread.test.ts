import { assertEquals as eq, assertAlmostEquals as near } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { capWeightedMinusMedian, medianReturn } from './breadth-spread.ts'

Deno.test('the weights are market capitalisation shares of the included rows', () => {
  // 900 at +1% and 100 at +11%: weighted 0.9*1 + 0.1*11 = 2.0; median of (1, 11) = 6.
  const r = capWeightedMinusMedian([
    { symbol: 'BIG', marketCap: 900, returnPct: 1 },
    { symbol: 'SMALL', marketCap: 100, returnPct: 11 },
  ])
  near(r.capWeightedReturnPct!, 2, 1e-12)
  eq(r.medianReturnPct, 6)
  near(r.spreadPts!, -4, 1e-12)
  eq(r.included, 2)
  near(r.top[0].weightPct, 90, 1e-12)
  eq(r.top.map((t) => t.symbol), ['BIG', 'SMALL'])
})

Deno.test('a median over an even count is the mean of the two middle values', () => {
  eq(medianReturn([4, -2, 10, 0]), 2)
  eq(medianReturn([3, 1, 2]), 2)
  eq(medianReturn([]), null)
  eq(medianReturn([-5]), -5)
})

Deno.test('rows without a market cap or a return are left out of BOTH sides and counted', () => {
  const r = capWeightedMinusMedian([
    { marketCap: 100, returnPct: 2 },
    { marketCap: 100, returnPct: 4 },
    { marketCap: null, returnPct: 90 },
    { marketCap: 0, returnPct: -90 },
    { marketCap: '', returnPct: 50 },
    { marketCap: 500, returnPct: null },
    { marketCap: 500, returnPct: 'n/a' },
  ])
  eq(r.included, 2)
  eq(r.excludedNoMarketCap, 3)
  eq(r.excludedNoReturn, 2)
  eq(r.total, 7)
  // Had the capless rows entered the median it would not be 3.
  eq(r.medianReturnPct, 3)
  eq(r.capWeightedReturnPct, 3)
  eq(r.spreadPts, 0)
})

Deno.test('a zero return is a reading, not a missing value', () => {
  const r = capWeightedMinusMedian([{ marketCap: 10, returnPct: 0 }, { marketCap: 10, returnPct: '0' }])
  eq(r.included, 2)
  eq(r.spreadPts, 0)
})

Deno.test('nothing usable is no reading at all, never a zero spread', () => {
  for (const rows of [[], null, undefined, [{ marketCap: null, returnPct: null }]]) {
    const r = capWeightedMinusMedian(rows as never)
    eq(r.spreadPts, null)
    eq(r.capWeightedReturnPct, null)
    eq(r.medianReturnPct, null)
    eq(r.included, 0)
    eq(r.top, [])
  }
})

Deno.test('the largest assets can carry the day while the typical asset falls', () => {
  const rows = [{ symbol: 'BTC', marketCap: 1_000_000, returnPct: 3 }, ...Array.from({ length: 9 }, (_, i) => ({ symbol: `A${i}`, marketCap: 1_000, returnPct: -2 }))]
  const r = capWeightedMinusMedian(rows, 2)
  eq(r.medianReturnPct, -2)
  eq(r.spreadPts! > 4.9, true)
  eq(r.top.length, 2)
})
