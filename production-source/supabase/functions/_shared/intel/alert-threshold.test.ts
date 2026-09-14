import { evaluateAlertThreshold as evaluate } from './alert-threshold.ts'
const assert = (v: unknown) => { if (!v) throw new Error('threshold assertion failed') }
Deno.test('absent, blank, zero and invalid measurements never become a price alert', () => {
  for (const threshold of [null, undefined, '', 0, -1, true, 'nope', Infinity]) assert(evaluate('price_move', { threshold_pct: threshold }, { price_change_24h_pct: 12 }) === null)
  for (const value of [null, undefined, '', true, 'nope', Infinity]) assert(evaluate('price_move', { threshold_pct: 10 }, { price_change_24h_pct: value }) === null)
})
Deno.test('price direction, volume spikes and dollar liquidity thresholds retain different semantics', () => {
  assert(evaluate('price_move', { threshold_pct: 10 }, { price_change_24h_pct: -11 })?.value === -11)
  assert(evaluate('volume_spike', { threshold_pct: 10 }, { volume_change_24h_pct: -11 }) === null)
  assert(evaluate('liquidity_drop', { min_liquidity_usd: 1000 }, { liquidity: 0 })?.unit === 'usd')
  assert(evaluate('liquidity_drop', { threshold_pct: 10 }, { liquidity: 100 }) === null)
  assert(evaluate('liquidity_drop', { min_liquidity_usd: 1000 }, { liquidity: -1 }) === null)
  assert(evaluate('liquidity_drop', { min_liquidity_usd: 1000 }, { liquidity: 1000 }) === null)
})
