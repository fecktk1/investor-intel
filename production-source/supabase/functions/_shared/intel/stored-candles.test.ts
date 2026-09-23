// Stored-price chart candles: the width a window is drawn at, what a bucket is
// built from, and what the answer is obliged to say. No database: the RPC is a fake.

import { assertEquals, assertStringIncludes, assertThrows } from 'jsr:@std/assert@1'
import {
  dailyRows, dayBars, intradayBars, loadStoredCandles, providerList, spacingWords, storedIdentity, storedWidthPlan,
  STORED_MAX_BARS, weekBars, widthAtLeast, widthAtMost, type StoredRpc, type StoredStats,
} from './stored-candles.ts'
import { chartSeriesResponse } from './chart-series-contract.ts'
import { loadMarketCandles } from './market-candle-read.ts'

// deno-lint-ignore no-explicit-any
type Any = any
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 23, 12, 30, 0)
const stats = (patch: Partial<StoredStats> = {}): StoredStats => ({
  points: 4000, first: new Date(NOW - 8 * DAY).toISOString(), last: new Date(NOW - MIN).toISOString(), spacingSeconds: 122,
  sources: { quotes: 4000 }, archiveFirst: null, backfillFirst: null, ...patch,
})

Deno.test('widths: the finest at or above a spacing, the widest at or below a window share', () => {
  assertEquals(widthAtLeast(244_000), '5M')
  assertEquals(widthAtLeast(2 * HOUR), '4H')
  assertEquals(widthAtLeast(12 * HOUR), '1D')
  assertEquals(widthAtMost(10 * MIN), '5M')
  assertEquals(widthAtMost(28 * HOUR), '1D')
  assertEquals(widthAtMost(1000), '1M')
})

Deno.test('Bitcoin-like spacing (about 2 min): 1H is 5-minute candles, 24H 15-minute, 7D hourly', () => {
  assertEquals(storedWidthPlan('1H', 'auto', stats(), NOW).width, '5M')
  assertEquals(storedWidthPlan('1H', 'auto', stats(), NOW).reason, 'price_spacing')
  assertEquals(storedWidthPlan('12H', 'auto', stats(), NOW).width, '5M')
  assertEquals(storedWidthPlan('24H', 'auto', stats(), NOW).width, '15M')
  assertEquals(storedWidthPlan('3D', 'auto', stats(), NOW).width, '1H')
  const week = storedWidthPlan('7D', 'auto', stats(), NOW)
  assertEquals([week.mode, week.width, week.substituted], ['intraday', '1H', false])
})

Deno.test('hourly prices: candles hold about two prices, and a short window still draws a few', () => {
  const hourly = stats({ spacingSeconds: 3600 })
  assertEquals(storedWidthPlan('7D', 'auto', hourly, NOW).width, '4H')
  assertEquals(storedWidthPlan('24H', 'auto', hourly, NOW).width, '4H')
  // A 12-hour window cannot hold 4-hour candles and still show a shape: hourly, one price each.
  const twelve = storedWidthPlan('12H', 'auto', hourly, NOW)
  assertEquals([twelve.width, twelve.reason], ['1H', 'short_window'])
})

Deno.test('six-hourly wrapper captures: a week is drawn from daily rows, a day from 4-hour buckets', () => {
  const sparse = stats({ spacingSeconds: 21600, points: 16 })
  const week = storedWidthPlan('7D', 'auto', sparse, NOW)
  assertEquals([week.mode, week.width], ['daily', '1D'])
  assertEquals(storedWidthPlan('24H', 'auto', sparse, NOW).width, '4H')
})

Deno.test('a month whose stored quotes begin a week ago is drawn from the archive when it reaches back', () => {
  const lateQuotes = stats({ first: new Date(NOW - 7 * DAY).toISOString(), archiveFirst: new Date(NOW - 30 * DAY).toISOString() })
  const month = storedWidthPlan('1M', 'auto', lateQuotes, NOW)
  assertEquals([month.mode, month.width, month.reason], ['daily', '1D', 'daily_reaches_further'])
  // With no daily row further back, the quotes are drawn and the shortfall is stated later.
  const alone = storedWidthPlan('1M', 'auto', stats({ first: new Date(NOW - 7 * DAY).toISOString() }), NOW)
  assertEquals([alone.mode, alone.width], ['intraday', '4H'])
})

Deno.test('ranges of a day width or more go to the daily rows without asking for stats', () => {
  assertEquals(storedWidthPlan('3M', 'auto', null, NOW).mode, 'daily')
  const all = storedWidthPlan('ALL', 'auto', null, NOW)
  assertEquals([all.width, all.weeklyIfLong], ['1W', true])
  assertEquals(storedWidthPlan('ALL', '1D', null, NOW).weeklyIfLong, false)
  assertThrows(() => storedWidthPlan('9Y', 'auto', null, NOW))
})

Deno.test('an explicit minute request on a one-month window steps up to stay under the candle ceiling', () => {
  const plan = storedWidthPlan('1M', '1M', stats({ spacingSeconds: 30 }), NOW)
  assertEquals(plan.reason, 'bar_ceiling')
  assertEquals((30 * DAY) / ({ '5M': 300000, '15M': 900000 } as Record<string, number>)[plan.width] <= STORED_MAX_BARS, true)
})

Deno.test('buckets: a single stored price is a flat candle, never an invented range; malformed rows are dropped', () => {
  const step = 5 * MIN
  const t = Math.floor(NOW / step) * step - 3 * step
  const built = intradayBars([
    [t, 100, 101, 99.5, 100.5, 2, t + 4 * MIN],
    [t + step, 100.5, 100.5, 100.5, 100.5, 1, t + step + MIN],
    [t + 2 * step + 1000, 1, 1, 1, 1, 1, 0], // not on the grid
    [t + 2 * step, 5, 1, 9, 5, 2, 0],        // high below low
  ], step)
  assertEquals(built.bars.length, 2)
  assertEquals([built.prices, built.singles], [3, 1])
  assertEquals(built.bars[1], { t: t + step, o: 100.5, h: 100.5, l: 100.5, c: 100.5, v: null, closedAt: t + 2 * step - 1 })
})

Deno.test('daily rows: archive candles keep OHLCV, backfill days are closes only, a gap stays a gap', () => {
  const d0 = Math.floor(NOW / DAY) * DAY - 5 * DAY
  const rows = dailyRows([
    [d0, 10, 12, 9, 11, 1000, null, 'archive', 'binance'],
    [d0 + DAY, null, null, null, 11.5, null, null, 'backfill', 'coinmarketcap'],
    // d0 + 2 days: nothing stored
    [d0 + 3 * DAY, 11, 11.8, 10.9, 11.2, null, 30, 'quotes', 'coinmarketcap'],
    [d0 + 4 * DAY, 11, 10, 12, 11, null, 3, 'quotes', 'coinmarketcap'], // inconsistent: kept as a close
  ])
  const built = dayBars(rows)
  assertEquals(built.bars.map((b) => b.t), [d0, d0 + DAY, d0 + 3 * DAY, d0 + 4 * DAY])
  assertEquals(built.bars[1].o, null)
  assertEquals(built.bars[3].o, null)
  assertEquals(built.closesOnly, 2)
  assertEquals(built.bars[0].v, 1000)
})

Deno.test('weeks: only complete Monday weeks; a week with a close-only day is a close', () => {
  const monday = Date.UTC(2026, 7, 31) // a Monday
  const full = Array.from({ length: 7 }, (_, i) => [monday + i * DAY, 10 + i, 11 + i, 9 + i, 10.5 + i, 5, null, 'archive', 'binance'])
  const partial = Array.from({ length: 5 }, (_, i) => [monday + 7 * DAY + i * DAY, 20, 21, 19, 20, 5, null, 'archive', 'binance'])
  const closes = Array.from({ length: 7 }, (_, i) => [monday + 14 * DAY + i * DAY, null, null, null, 30 + i, null, null, 'backfill', 'coinmarketcap'])
  const built = weekBars(dailyRows([...full, ...partial, ...closes]), NOW)
  assertEquals(built.bars.map((b) => b.t), [monday, monday + 14 * DAY])
  assertEquals(built.bars[0], { t: monday, closedAt: monday + 7 * DAY - 1, c: 16.5, o: 10, h: 17, l: 9, v: 35, volumeKind: 'period', volumeUnit: 'USD' })
  assertEquals([built.bars[1].o, built.bars[1].c], [null, 36])
})

Deno.test('identity: a CoinMarketCap row reads its id and archive keys; a CoinGecko row reads snapshots', () => {
  const btc = storedIdentity({ source_provider: 'coinmarketcap', provider_id: '1' })
  assertEquals(btc.cmcId, '1')
  assertEquals(btc.archiveKeys.includes('cmc:1'), true)
  const gecko = storedIdentity({ source_provider: 'coingecko', provider_id: 'the-open-network', platforms: {} })
  assertEquals([gecko.cmcId, gecko.coingeckoId], [null, 'the-open-network'])
  assertEquals(providerList(['coinmarketcap', 'binance', 'coinmarketcap']), 'binance+coinmarketcap')
  assertEquals(spacingWords(122), '2 min')
  assertEquals(spacingWords(21600), '6 h')
})

function fakeRpc(answers: Record<string, Any>, calls: Any[] = []): StoredRpc {
  return (mode, args) => { calls.push({ mode, ...args }); return Promise.resolve(answers[mode]) }
}

Deno.test('BTC 1H: twelve 5-minute candles from stored quotes, labelled, with no provider call', async () => {
  const step = 5 * MIN
  const end = Math.floor(NOW / step) * step
  const bars = Array.from({ length: 12 }, (_, i) => { const t = end - (12 - i) * step; return [t, 100 + i, 101 + i, 99 + i, 100.5 + i, 2, t + 4 * MIN] })
  const calls: Any[] = []
  const answer = await loadStoredCandles(null, { cmcId: '1', coingeckoId: null, archiveKeys: [] }, '1H', 'auto', NOW, 0,
    fakeRpc({ stats: stats(), buckets: { bars, sources: { quotes: 24 }, last: new Date(end - MIN).toISOString() } }, calls))
  assertEquals(answer.candles.length, 12)
  assertEquals(answer.barIntervalMs, step)
  assertEquals(answer.source, 'coinmarketcap')
  assertEquals(answer.storedSeries.mode, 'quotes')
  assertEquals(answer.storedSeries.prices, 24)
  assertEquals(answer.sourceState, 'fresh')
  assertEquals(calls.map((c) => c.mode), ['stats', 'buckets'])
  assertEquals(calls[1].bucketSeconds, 300)
  assertStringIncludes(answer.coverage, 'no provider was asked')
  assertStringIncludes(answer.coverage, 'not of every trade')
  // The response contract keeps OPEN times for a stored series, and the width.
  const series = chartSeriesResponse({ ...answer })
  assertEquals(series.source.timestampMeaning, 'open')
  assertEquals(series.source.intervalMs, step)
})

Deno.test('SGOVon 3M: backfill closes and quote days make a line of daily closes, said plainly', async () => {
  const d0 = Math.floor(NOW / DAY) * DAY - 90 * DAY
  const days = Array.from({ length: 90 }, (_, i) => i < 87
    ? [d0 + i * DAY, null, null, null, 101 + i / 100, null, null, 'backfill', 'coinmarketcap']
    : [d0 + i * DAY, 102, 102.4, 101.9, 102.2, null, 20, 'quotes', 'coinmarketcap'])
  const answer = await loadStoredCandles(null, { cmcId: '39306', coingeckoId: null, archiveKeys: [] }, '3M', 'auto', NOW, 0,
    fakeRpc({ daily: { days, sources: { quotes: 60, wrapper_captures: 12 }, last: new Date(NOW - 4 * HOUR).toISOString() } }))
  assertEquals(answer.candles.length, 90)
  assertEquals(answer.storedSeries.mode, 'daily')
  assertEquals(answer.storedSeries.days, { archive: 0, backfill: 87, quotes: 3, archiveProviders: [] })
  assertEquals(answer.storedSeries.closesOnly, 87)
  assertStringIncludes(answer.coverage, '87 daily closes from the CoinMarketCap OHLCV backfill')
  assertStringIncludes(answer.coverage, 'draws a line of closes')
})

Deno.test('ALL on auto: daily until the stored days exceed the weekly threshold', async () => {
  const d0 = Math.floor(NOW / DAY) * DAY - 400 * DAY
  const days = Array.from({ length: 400 }, (_, i) => [d0 + i * DAY, 1, 2, 0.5, 1.5, 10, null, 'archive', 'coinmarketcap'])
  const answer = await loadStoredCandles(null, { cmcId: '42', coingeckoId: null, archiveKeys: [] }, 'ALL', 'auto', NOW, 0, fakeRpc({ daily: { days, sources: {} } }))
  assertEquals([answer.storedSeries.mode, answer.barIntervalMs, answer.storedSeries.substituted], ['daily', DAY, false])
})

Deno.test('nothing stored: an empty answer with a reason, never an invented candle', async () => {
  const answer = await loadStoredCandles(null, { cmcId: '77', coingeckoId: null, archiveKeys: [] }, '7D', 'auto', NOW, 0,
    fakeRpc({ stats: stats({ points: 0, first: null, last: null, spacingSeconds: null }), daily: { days: [], sources: {} } }))
  assertEquals(answer.candles, [])
  assertEquals(answer.sourceReason, 'no_stored_prices')
})

Deno.test('the member ladder falls back to stored prices only when no live rung answered', async () => {
  const stored = { candles: [{ t: NOW - 2 * HOUR, o: 1, h: 1, l: 1, c: 1, v: null }, { t: NOW - HOUR, o: 1, h: 1, l: 1, c: 1, v: null }], source: 'coinmarketcap', coverage: 'Stored.', storedSeries: { mode: 'quotes' }, ladder: { source: 'stored' } }
  const identity = { assetKey: 'cmc:39306', symbol: 'SGOVON', cexVerified: false, cmcId: '39306', klineIdentity: false, coingeckoId: false }
  let asked = 0
  const fell: Any = await loadMarketCandles(identity, '1H', 'auto', NOW, { stored: () => { asked++; return Promise.resolve(stored) } })
  assertEquals(asked, 1)
  assertEquals(fell.storedSeries.mode, 'quotes')
  assertEquals(fell.ladder.sourcesTried.at(-1), 'stored')
  // A live rung that answers is never replaced by stored prices.
  const live = { candles: [{ t: NOW - HOUR, o: 1, h: 2, l: 1, c: 2, v: 1 }], source: 'coinmarketcap' }
  const answered: Any = await loadMarketCandles(identity, '7D', 'auto', NOW, { cmc: () => Promise.resolve(live), stored: () => { asked++; return Promise.resolve(stored) } })
  assertEquals(asked, 1)
  assertEquals(answered.storedSeries, undefined)
})
