import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { computeRowFlags, categoryLeaders } from './market-derived.ts'

Deno.test('precomputed derived flags pass through', () => {
  const f = computeRowFlags({ derived: { unusual_volume: true, volume_ratio: 4.2, vol_up_price_flat: true } })
  assert(f.unusualVolume)
  assertEquals(f.volumeRatio, 4.2)
  assert(f.volUpPriceFlat)
})

Deno.test('price up + thin DEX liquidity → caution; absent liquidity → NO claim', () => {
  const weak = computeRowFlags({ change24hPct: 12, dex: { liquidityUsd: 30_000 } })
  assert(weak.priceUpLiquidityWeak)
  assert(weak.cautionFlags.includes('price_up_liquidity_weak'))
  const noData = computeRowFlags({ change24hPct: 12, dex: null })
  assert(!noData.priceUpLiquidityWeak, 'no liquidity data → no claim')
})

Deno.test('multi-exchange strength needs ≥3 venues + bullish + ≥2 confirming', () => {
  const yes = computeRowFlags({ signalDirection: 'bullish', cex: { availableCount: 3, marketContext: { confirmingProviders: ['binance', 'kraken'] } } })
  assert(yes.multiExchangeStrength)
  const few = computeRowFlags({ signalDirection: 'bullish', cex: { availableCount: 2, marketContext: { confirmingProviders: ['binance', 'kraken'] } } })
  assert(!few.multiExchangeStrength)
  const bearish = computeRowFlags({ signalDirection: 'bearish', cex: { availableCount: 4, marketContext: { confirmingProviders: ['binance', 'kraken'] } } })
  assert(!bearish.multiExchangeStrength)
})

Deno.test('thin liquidity: DEX floor OR single-CEX small cap; spread caution only at high confidence', () => {
  assert(computeRowFlags({ dex: { liquidityUsd: 10_000 } }).thinLiquidity)
  assert(computeRowFlags({ marketCap: 5_000_000, cex: { availableCount: 1 } }).thinLiquidity)
  assert(!computeRowFlags({ marketCap: 5_000_000_000, cex: { availableCount: 1 } }).thinLiquidity)
  assert(computeRowFlags({ enrichmentConfidence: 'high', cex: { availableCount: 3, spreadPct: 2.0 } }).spreadCaution)
  assert(!computeRowFlags({ enrichmentConfidence: 'medium', cex: { availableCount: 3, spreadPct: 2.0 } }).spreadCaution)
})

Deno.test('categoryLeaders: top per category, needs ≥3 members', () => {
  const mk = (symbol: string, cat: string, chg: number, mc: number) => ({ symbol, categories: [cat], change24hPct: chg, marketCap: mc })
  const rows = [
    mk('A', 'AI', 12, 1e9), mk('B', 'AI', 3, 5e9), mk('C', 'AI', -2, 1e8),
    mk('D', 'Meme', 50, 1e7), mk('E', 'Meme', 1, 1e6), // only 2 members → excluded
  ]
  const out = categoryLeaders(rows)
  assertEquals(out.length, 1)
  assertEquals(out[0].category, 'AI')
  assertEquals(out[0].leaders[0].symbol, 'A')
})
