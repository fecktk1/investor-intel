import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  loadKlineChart, contractCandleLadder, klinePlan, klineBars, klineIdentity, klineAutoInterval, klineEpochMs,
  KLINE_INTERVALS, KLINE_PAGE, KLINE_MAX_PAGES, KLINE_SOURCE,
} from './cmc-kline-chart.ts'
import { cmcParams } from '../market-assets/cmc-capabilities.ts'
import { cmcDexIdentity } from '../market-assets/cmc-dex.ts'

const HOUR = 3_600_000, DAY = 86_400_000
// A whole hour a week in the past: every synthesised close time stays behind the
// real clock, so no test candle is accidentally an in-progress period.
const NOW = Math.floor((Date.now() - 7 * DAY) / HOUR) * HOUR
const EVM = '0x' + 'a'.repeat(40)
const SOL = 'So11111111111111111111111111111111111111112'
const identity = cmcDexIdentity(`eip155:1:${EVM}`)!
const contractAsset = (chain = 'ethereum', address = EVM) => ({ source_provider: 'contract', provider_id: `${chain}:${address}`, primary_chain: chain, contract: { chain, address } })

/** k-line rows are POSITIONAL: [o,h,l,c,v,tSeconds,traders]. */
const candle = (tMs: number, close = 2, volume = 10, traders = 3) => [close - 0.5, close + 0.5, close - 1, close, volume, Math.floor(tMs / 1000), traders]
const payload = (rows: unknown[]) => ({ data: rows })

// deno-lint-ignore no-explicit-any
function fakeRequest(handler: (name: string, params: Record<string, unknown>, call: number) => any) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown> = {}, _ctx?: any) => {
    calls.push({ name, params })
    return Promise.resolve(handler(name, params, calls.length))
  }
  return { request, calls }
}
const ok = (rows: unknown[], state = 'fresh') => ({ payload: payload(rows), state, reason: null, provenance: { provider: 'coinmarketcap', fetchedAt: new Date(NOW).toISOString(), observedAt: null, expiresAt: null, sourceUrl: 'x' } })
const startup = () => Promise.resolve('startup')

Deno.test('the app interval vocabulary maps onto the eight named provider widths', () => {
  eq(KLINE_INTERVALS['1M'], '1min')
  eq(KLINE_INTERVALS['5M'], '5min')
  eq(KLINE_INTERVALS['15M'], '15min')
  eq(KLINE_INTERVALS['30M'], '30min')
  eq(KLINE_INTERVALS['1H'], '1h')
  eq(KLINE_INTERVALS['4H'], '4h')
  eq(KLINE_INTERVALS['1D'], '1d')
  eq(KLINE_INTERVALS['1W'], '1w')
  // Every mapped width is one the registry accepts, so no plan can build a
  // request the canonicaliser would reject.
  for (const [app, provider] of Object.entries(KLINE_INTERVALS)) {
    const params = cmcParams('dexCandles', { platform: 'ethereum', address: EVM, interval: provider, unit: 'usd', limit: 10 })
    eq(params.interval, provider, app)
  }
})

Deno.test('sub-minute is refused by the registry, not silently relabelled', () => {
  let threw = ''
  try { cmcParams('dexCandles', { platform: 'ethereum', address: EVM, interval: '1s' }) } catch (e) { threw = (e as Error).message }
  eq(threw, 'invalid_candle_interval')
  assert(!Object.keys(KLINE_INTERVALS).some((k) => /^\d+S$/i.test(k)), 'no app key claims a sub-minute candle')
})

Deno.test('auto picks the interval from the window', () => {
  eq(klineAutoInterval(HOUR), '1M')
  eq(klineAutoInterval(12 * HOUR), '5M')
  eq(klineAutoInterval(DAY), '15M')
  eq(klineAutoInterval(3 * DAY), '1H')
  eq(klineAutoInterval(7 * DAY), '1H')
  eq(klineAutoInterval(30 * DAY), '1D')
  eq(klinePlan('1H', 'auto', NOW).selected, '1M')
  eq(klinePlan('12H', 'auto', NOW).selected, '5M')
  eq(klinePlan('24H', 'auto', NOW).selected, '15M')
  eq(klinePlan('7D', 'auto', NOW).selected, '1H')
  eq(klinePlan('1Y', 'auto', NOW).selected, '1D')
})

Deno.test('the plan pages at a thousand candles and keeps the newest window when it is cut', () => {
  const one = klinePlan('7D', '1H', NOW)
  eq(one.pages.length, 1)
  eq(one.pages[0].limit, 168)
  eq(one.step, HOUR)
  assert(!one.limited)
  // 30 days of one-minute candles is 43,200 periods: four pages of 1000, newest first.
  const cut = klinePlan('1M', '1M', NOW)
  eq(cut.pages.length, KLINE_MAX_PAGES)
  eq(cut.pages.every((p) => p.limit === KLINE_PAGE), true)
  eq(cut.limited, true)
  eq(cut.to, NOW)
  eq(cut.from, NOW - KLINE_MAX_PAGES * KLINE_PAGE * 60_000)
  // from/to are SECONDS — exactly what cmcParams validates.
  for (const page of cut.pages) {
    assert(/^\d{9,10}$/.test(String(page.from)), 'from is seconds')
    assert(/^\d{9,10}$/.test(String(page.to)), 'to is seconds')
  }
})

Deno.test('a second timestamp becomes milliseconds and a millisecond one is left alone', () => {
  eq(klineEpochMs(1_700_000_000), 1_700_000_000_000)
  eq(klineEpochMs(1_700_000_000_000), 1_700_000_000_000)
  eq(klineEpochMs(0), null)
  eq(klineEpochMs('nope'), null)
})

Deno.test('closedAt is synthesised from the interval and the in-progress period is dropped', () => {
  const t = NOW - 2 * HOUR
  const bars = klineBars(payload([candle(t), candle(t + HOUR), candle(NOW)]), HOUR, null, NOW)
  eq(bars.length, 2, 'the period opening at NOW has not closed yet')
  eq(bars[0].t, t)
  eq(bars[0].closedAt, t + HOUR - 1)
  eq(bars[1].closedAt, t + 2 * HOUR - 1)
})

Deno.test('a zero-volume candle is kept as a zero', () => {
  const t = NOW - HOUR
  const bars = klineBars(payload([candle(t, 2, 0)]), HOUR, null, NOW)
  eq(bars.length, 1)
  eq(bars[0].v, 0)
  eq(bars[0].volumeUnit, 'USD')
})

Deno.test('loadKlineChart returns the loadCmcChart object shape', async () => {
  const rows = Array.from({ length: 24 }, (_, i) => candle(NOW - (24 - i) * HOUR, 2 + i))
  const { request, calls } = fakeRequest(() => ok(rows))
  const chart = await loadKlineChart({}, identity, '24H', '1H', NOW, {}, { request, plan: startup })
  eq(calls.length, 1)
  eq(calls[0].name, 'dexCandles')
  eq(calls[0].params.interval, '1h')
  eq(calls[0].params.unit, 'usd')
  eq(calls[0].params.platform, 'ethereum')
  eq(calls[0].params.address, EVM)
  eq(chart.source, KLINE_SOURCE)
  eq(chart.bestProvider, KLINE_SOURCE)
  eq(chart.bestPair, null)
  eq(chart.timestampMeaning, 'open')
  eq(chart.barIntervalMs, HOUR)
  eq(chart.volumeUnit, 'USD')
  eq(chart.sourceState, 'fresh')
  eq(chart.sourceReason, null)
  eq(chart.candles.length, 24)
  eq(chart.provenance.length, 1)
  assert(chart.coverage.includes('derived from the requested interval'), 'the synthesised close time is stated')
})

Deno.test('every page is requested and the bars are merged', async () => {
  const plan = klinePlan('1M', '1M', NOW)
  const { request, calls } = fakeRequest((_name, params) => {
    const from = Number(params.from) * 1000
    return ok(Array.from({ length: 3 }, (_, i) => candle(from + i * 60_000, 1 + i)))
  })
  const chart = await loadKlineChart({}, identity, '1M', '1M', NOW, {}, { request, plan: startup })
  eq(calls.length, plan.pages.length)
  eq(calls.length, KLINE_MAX_PAGES)
  eq(chart.candles.length, KLINE_MAX_PAGES * 3)
  assert(chart.coverage.includes('cut to the newest'), 'a cut window says so')
})

Deno.test('an empty answer is unavailable with no_completed_candles', async () => {
  const { request } = fakeRequest(() => ok([]))
  const chart = await loadKlineChart({}, identity, '7D', '1H', NOW, {}, { request, plan: startup })
  eq(chart.candles.length, 0)
  eq(chart.sourceState, 'unavailable')
  eq(chart.sourceReason, 'no_completed_candles')
  eq(chart.bestProvider, null)
})

Deno.test('a provider reason survives onto an empty chart', async () => {
  const { request } = fakeRequest(() => ({ payload: null, state: 'unavailable', reason: 'budget_exceeded', provenance: null }))
  const chart = await loadKlineChart({}, identity, '7D', '1H', NOW, {}, { request, plan: startup })
  eq(chart.sourceState, 'unavailable')
  eq(chart.sourceReason, 'budget_exceeded')
})

Deno.test('below Startup the rung is skipped without a call', async () => {
  const { request, calls } = fakeRequest(() => ok([candle(NOW - HOUR)]))
  const chart = await loadKlineChart({}, identity, '7D', '1H', NOW, {}, { request, plan: () => Promise.resolve('basic') })
  eq(calls.length, 0, 'no credit is spent to discover the plan gate')
  eq(chart.sourceReason, 'plan_below_startup')
  eq(chart.sourceState, 'unavailable')
  eq(chart.barIntervalMs, HOUR)
})

Deno.test('a contract on an unverified chain has no k-line identity', () => {
  assert(klineIdentity(contractAsset('ethereum')), 'ethereum is verified')
  assert(klineIdentity(contractAsset('base')), 'base is verified')
  assert(klineIdentity(contractAsset('arbitrum')), 'arbitrum is verified')
  assert(klineIdentity(contractAsset('solana', SOL)), 'solana is verified')
  eq(klineIdentity(contractAsset('polygon')), null)
  eq(klineIdentity(contractAsset('bnb')), null)
  eq(klineIdentity({ source_provider: 'coinmarketcap', provider_id: '1027' }), null)
  eq(klineIdentity(contractAsset('ethereum', 'not-an-address')), null)
})

Deno.test('the ladder tries k-line before the pool for a verified chain', async () => {
  const order: string[] = []
  const kline = () => { order.push('kline'); return Promise.resolve({ candles: [{ t: NOW - HOUR, c: 1, closedAt: NOW - 1 }], source: KLINE_SOURCE, sourceReason: null } as never) }
  const pool = () => { order.push('pool'); return Promise.resolve({ candles: [{ t: NOW - HOUR, c: 2 }], bestPair: 'p', bestProvider: 'geckoterminal' } as never) }
  const result = await contractCandleLadder({}, contractAsset(), '7D', 'auto', {}, { kline, pool }, NOW)
  eq(order, ['kline'], 'the pool is not called when the aggregate answered')
  eq((result as { source?: string }).source, KLINE_SOURCE)
})

Deno.test('the ladder falls through to the pool with the k-line reason on it', async () => {
  const order: string[] = []
  const kline = () => { order.push('kline'); return Promise.resolve({ candles: [], source: KLINE_SOURCE, sourceReason: 'plan_below_startup' } as never) }
  // deno-lint-ignore no-explicit-any
  const pool = (_a: any, _r: string, interval = 'auto') => { order.push(`pool:${interval}`); return Promise.resolve({ candles: [{ t: NOW - HOUR, c: 2 }], bestPair: 'p', bestProvider: 'geckoterminal' } as never) }
  const result = await contractCandleLadder({}, contractAsset(), '7D', 'auto', {}, { kline, pool }, NOW) as Record<string, unknown>
  eq(order, ['kline', 'pool:auto'])
  eq(result.bestProvider, 'geckoterminal')
  eq(result.klineReason, 'plan_below_startup')
  assert(String(result.coverage).includes('plan_below_startup'), 'the page can say what was tried')
})

Deno.test('an unverified chain skips the rung entirely and never asks for sub-hour pool candles', async () => {
  const order: string[] = []
  const kline = () => { order.push('kline'); return Promise.resolve({ candles: [], source: KLINE_SOURCE, sourceReason: null } as never) }
  // deno-lint-ignore no-explicit-any
  const pool = (_a: any, _r: string, interval = 'auto') => { order.push(`pool:${interval}`); return Promise.resolve({ candles: [], bestPair: null, bestProvider: null } as never) }
  const result = await contractCandleLadder({}, contractAsset('polygon'), '24H', '5M', {}, { kline, pool }, NOW) as Record<string, unknown>
  eq(order, ['pool:auto'], 'no k-line call for a chain CMC DEX does not cover')
  eq(result.klineReason, 'no_cmc_dex_chain')
  assert(String(result.coverage).includes('Sub-hour candles come only from'), 'the substituted spacing is stated')
})
