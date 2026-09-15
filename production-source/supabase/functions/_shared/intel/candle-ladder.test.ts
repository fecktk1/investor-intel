// The candle ladder: which width a (range, interval) pair resolves to, which
// source is asked in which order, what a bounded request can reach, and what the
// coverage sentence is obliged to say about all of it.

import { assertEquals, assertStringIncludes, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  autoInterval, candleCoverage, candlePlan, candleSourceOrder, CANDLE_RANGE_MS, isArchiveRange,
  nearestInterval, spanWords, VENUE_CANDLES, CMC_INTERVAL_KEYS,
} from './candle-ladder.ts'
import { archiveBar, archiveCanAnswer, mergeCandles, STORED_INTERVALS } from './candle-archive.ts'
import { exchangeBars, loadExchangeCandles } from './exchange-candles.ts'
import { loadMarketCandles, resolveInterval } from './market-candle-read.ts'

const HOUR = 3_600_000, DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)

Deno.test('every range in the vocabulary is answerable and the three new ones are archive ranges', () => {
  for (const key of ['1H', '12H', '24H', '3D', '7D', '1M', '3M', '6M', '1Y', '2Y', '5Y', 'ALL']) {
    assertEquals(typeof CANDLE_RANGE_MS[key], 'number', key)
  }
  assertEquals(CANDLE_RANGE_MS['2Y'], 2 * 365 * DAY)
  assertEquals(CANDLE_RANGE_MS.ALL, 20 * 365 * DAY)
  assertEquals(['1Y', '2Y', '5Y', 'ALL'].every(isArchiveRange), true)
  assertEquals(['7D', '1M', '6M'].some(isArchiveRange), false)
})

Deno.test('automatic widths step up with the window and never leave a decade at daily spacing', () => {
  assertEquals(autoInterval(HOUR), '1M')
  assertEquals(autoInterval(12 * HOUR), '5M')
  assertEquals(autoInterval(DAY), '15M')
  assertEquals(autoInterval(7 * DAY), '1H')
  assertEquals(autoInterval(30 * DAY), '4H')
  assertEquals(autoInterval(365 * DAY), '1D')
  assertEquals(autoInterval(CANDLE_RANGE_MS['2Y']), '1D')
  assertEquals(autoInterval(CANDLE_RANGE_MS['5Y']), '1W')
  assertEquals(autoInterval(CANDLE_RANGE_MS.ALL), '1W')
  // A nonsense duration still answers a width rather than throwing into a chart.
  assertEquals(autoInterval(Number.NaN), '1H')
})

Deno.test('a width a source cannot sample resolves to the FINEST width it can, never a relabelled one', () => {
  // Coinbase has no 30-minute or 4-hour bucket: 30M steps up to 1H, 4H to 1D.
  assertEquals(nearestInterval('30M', VENUE_CANDLES.coinbase.intervals), '1H')
  assertEquals(nearestInterval('4H', VENUE_CANDLES.coinbase.intervals), '1D')
  assertEquals(nearestInterval('1W', VENUE_CANDLES.coinbase.intervals), '1D')
  // Binance samples every width, so nothing is substituted.
  for (const width of VENUE_CANDLES.binance.intervals) assertEquals(nearestInterval(width, VENUE_CANDLES.binance.intervals), width)
  // CoinMarketCap OHLCV has no period below an hour.
  assertEquals(nearestInterval('5M', CMC_INTERVAL_KEYS), '1H')
  assertEquals(nearestInterval('nonsense', VENUE_CANDLES.binance.intervals), null)
  assertEquals(nearestInterval('1D', []), null)
})

Deno.test('a plan never asks for more periods than the source returns and says how far back it reaches', () => {
  // 1 minute over one year: 525,600 periods against a 1000-candle venue ceiling.
  const plan = candlePlan('1Y', '1M', VENUE_CANDLES.binance, NOW)
  assertEquals(plan.selected, '1M')
  assertEquals(plan.limit, 1000)
  assertEquals(plan.capped, true)
  assertEquals(plan.wanted, 525_600)
  // The newest 1000 one-minute candles reach back about 17 hours, not a year.
  assertEquals(plan.reachesFrom, plan.to - 999 * 60_000)
  const coverage = candleCoverage({ plan, source: 'binance', oldest: plan.reachesFrom, count: 1000 })
  assertStringIncludes(coverage, '1 minute candles for 1Y from Binance')
  assertStringIncludes(coverage, 'more than the 1000-candle ceiling')
  assertStringIncludes(coverage, 'They reach back about 17 hours, not the full 1Y range.')
})

Deno.test('a plan that fits is not capped and the coverage sentence claims no shortfall', () => {
  const plan = candlePlan('7D', '1H', VENUE_CANDLES.binance, NOW)
  assertEquals(plan.selected, '1H')
  assertEquals(plan.wanted, 168)
  assertEquals(plan.limit, 169)
  assertEquals(plan.capped, false)
  const coverage = candleCoverage({ plan, source: 'binance', oldest: plan.from, count: 168 })
  assertStringIncludes(coverage, '1 hour candles for 7D from Binance')
  assertEquals(coverage.includes('reach back about'), false)
  assertEquals(coverage.includes('ceiling'), false)
})

Deno.test('a substituted width is named as the width that was actually served', () => {
  const plan = candlePlan('1M', '4H', VENUE_CANDLES.coinbase, NOW)
  assertEquals(plan.requested, '4H')
  assertEquals(plan.selected, '1D')
  assertEquals(plan.substituted, true)
  const coverage = candleCoverage({ plan, source: 'coinbase', oldest: plan.from, count: 30 })
  assertStringIncludes(coverage, '1 day candles for 1M from Coinbase')
  assertStringIncludes(coverage, 'not relabelled 4 hour ones')
})

Deno.test('a range or width outside the vocabulary is an error, not a quiet default', () => {
  assertThrows(() => candlePlan('10Y', 'auto', VENUE_CANDLES.binance, NOW), Error, 'invalid_chart_parameters')
  assertThrows(() => candlePlan('7D', '3M', VENUE_CANDLES.binance, NOW), Error, 'invalid_chart_parameters')
  assertThrows(() => candlePlan('7D', 'auto', VENUE_CANDLES.binance, Number.NaN), Error, 'invalid_chart_parameters')
  assertThrows(() => resolveInterval('10Y', 'auto'), Error, 'invalid_chart_parameters')
})

Deno.test('span words round to the unit a reader can check against the chart', () => {
  assertEquals(spanWords(HOUR), '1 hour')
  assertEquals(spanWords(3 * DAY), '3 days')
  assertEquals(spanWords(3 * 365 * DAY), '3 years')
  assertEquals(spanWords(0), 'no completed period')
  assertEquals(spanWords(Number.NaN), 'no completed period')
})

Deno.test('source order is exchange, CoinMarketCap OHLCV, DEX k-line, CoinGecko', () => {
  assertEquals(candleSourceOrder({ cexVerified: true, cmcId: '1', klineIdentity: true, coingeckoId: true, interval: '1H' }),
    ['exchange', 'cmc_ohlcv', 'kline', 'coingecko'])
  // A pasted contract has no verified exchange identity: its own on-chain
  // trading is the FIRST rung, never a same-ticker market.
  assertEquals(candleSourceOrder({ cexVerified: false, cmcId: null, klineIdentity: true, coingeckoId: false, interval: '1H' }), ['kline'])
  // A sub-hour request skips CoinMarketCap OHLCV: it has no period below an hour.
  assertEquals(candleSourceOrder({ cexVerified: true, cmcId: '1027', klineIdentity: false, coingeckoId: false, interval: '5M' }), ['exchange'])
  assertEquals(candleSourceOrder({ cexVerified: true, cmcId: '1027', klineIdentity: false, coingeckoId: false, interval: '1H' }), ['exchange', 'cmc_ohlcv'])
  // An asset with no verified identity anywhere asks nothing rather than guessing.
  assertEquals(candleSourceOrder({ cexVerified: false, cmcId: null, klineIdentity: false, coingeckoId: false, interval: '1D' }), [])
})

// ─── exchange rung ────────────────────────────────────────────────────────────

const kline = (t: number, step: number, close: number, extra: Record<string, unknown> = {}) =>
  ({ openTime: t, closeTime: t + step, open: close - 1, high: close + 1, low: close - 2, close, volumeBase: 5, committed: true, ...extra })

Deno.test('exchange bars keep closed periods, drop the period in progress and keep a zero volume', () => {
  const step = HOUR
  const bars = exchangeBars([
    kline(NOW - 3 * step, step, 100),
    kline(NOW - 2 * step, step, 101, { volumeBase: 0 }),
    kline(NOW - step, step, 102, { committed: false }),
    kline(NOW, step, 103, { close: 'not a number' }),
    { openTime: 'x', closeTime: NOW },
  ], NOW)
  assertEquals(bars.length, 2)
  assertEquals(bars[0].c, 100)
  // A period in which nothing traded is a real zero, not a missing value.
  assertEquals(bars[1].v, 0)
})

Deno.test('the exchange rung names the venue it used and falls through the ones that could not answer', async () => {
  const step = HOUR
  const calls: string[] = []
  const result = await loadExchangeCandles({}, 'BTC', '7D', '1H', NOW, {
    tickers: () => Promise.resolve([
      { provider: 'kraken', provider_symbol: 'XBTUSD', quote_asset: 'USD', volume_quote_24h: 900 },
      { provider: 'binance', provider_symbol: 'BTCUSDT', quote_asset: 'USDT', volume_quote_24h: 100 },
    ]),
    provider: (id: string) => ({
      getKlines: (symbol: string, interval: string, limit: number) => {
        calls.push(`${id}:${symbol}:${interval}:${limit}`)
        if (id === 'kraken') return Promise.resolve([])
        return Promise.resolve(Array.from({ length: 5 }, (_, i) => kline(Math.floor(NOW / step) * step - (5 - i) * step, step, 100 + i)))
      },
    }),
  })
  assertEquals(calls, ['kraken:XBTUSD:1h:169', 'binance:BTCUSDT:1h:169'])
  assertEquals(result.source, 'binance')
  assertEquals(result.bestPair, 'BTCUSDT')
  assertEquals(result.candles.length, 5)
  assertEquals(result.currency, 'USDT')
  assertStringIncludes(result.coverage, 'from Binance')
  assertStringIncludes(result.coverage, 'kraken could not answer')
})

Deno.test('the exchange rung is a reason, never an invented series, when nothing lists the symbol', async () => {
  const result = await loadExchangeCandles({}, 'NOTLISTED', '7D', 'auto', NOW, { tickers: () => Promise.resolve([]) })
  assertEquals(result.candles, [])
  assertEquals(result.sourceReason, 'no_exchange_listing')
  assertStringIncludes(result.coverage, 'No cached public exchange listing for NOTLISTED.')
})

Deno.test('a sub-hour width is served by the venue for a listed asset, not refused', async () => {
  const step = 60_000
  let asked = ''
  const result = await loadExchangeCandles({}, 'ETH', '1H', '1M', NOW, {
    tickers: () => Promise.resolve([{ provider: 'binance', provider_symbol: 'ETHUSDT', quote_asset: 'USDT', volume_quote_24h: 1 }]),
    provider: () => ({
      getKlines: (_s: string, interval: string, limit: number) => {
        asked = `${interval}:${limit}`
        return Promise.resolve(Array.from({ length: 60 }, (_, i) => kline(Math.floor(NOW / step) * step - (60 - i) * step, step, 3000 + i)))
      },
    }),
  })
  assertEquals(asked, '1m:61')
  assertEquals(result.barIntervalMs, 60_000)
  assertEquals(result.candles.length, 60)
  assertStringIncludes(result.coverage, '1 minute candles for 1H from Binance')
})

// ─── archive ──────────────────────────────────────────────────────────────────

Deno.test('only the stored widths and the weekly candle built from them are archive answers', () => {
  assertEquals(STORED_INTERVALS['1D'], '1d')
  assertEquals(STORED_INTERVALS['1H'], '1h')
  assertEquals(['1H', '1D', '1W'].every(archiveCanAnswer), true)
  assertEquals(['1M', '5M', '15M', '30M', '4H'].some(archiveCanAnswer), false)
})

Deno.test('a stored row becomes a bar with a derived close, a real zero volume and an unreported null', () => {
  const t = Date.UTC(2015, 0, 2)
  const bar = archiveBar({ candle_time: new Date(t).toISOString(), open: 1, high: 2, low: 0.5, close: 1.5, volume: 0, recorded_at: new Date(t + DAY).toISOString() }, DAY)!
  assertEquals(bar.t, t)
  assertEquals(bar.closedAt, t + DAY - 1)
  assertEquals(bar.v, 0)
  assertEquals(bar.recordedAt, t + DAY)
  assertEquals(archiveBar({ candle_time: new Date(t).toISOString(), close: 1.5, volume: null }, DAY)!.v, null)
  // A row with no close is not a candle and is not invented as one.
  assertEquals(archiveBar({ candle_time: new Date(t).toISOString(), close: null }, DAY), null)
  assertEquals(archiveBar({ candle_time: 'not a time', close: 1 }, DAY), null)
})

Deno.test('the archive fills only what the provider window cannot reach and the provider wins any overlap', () => {
  const day = (n: number) => Date.UTC(2026, 0, n)
  const archive = [1, 2, 3, 4].map((n) => ({ t: day(n), c: n, closedAt: day(n) + DAY - 1 }))
  const tail = [3, 4, 5].map((n) => ({ t: day(n), c: n * 10, closedAt: day(n) + DAY - 1 }))
  const merged = mergeCandles(archive, tail)
  assertEquals(merged.candles.map((b) => b.c), [1, 2, 30, 40, 50])
  assertEquals(merged.archived, 2)
  assertEquals(merged.live, 3)
  assertEquals(merged.archiveFrom, day(1))
  assertEquals(merged.archiveTo, day(4))
})

// ─── the whole read ───────────────────────────────────────────────────────────

const candles = (from: number, step: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ t: from + i * step, c: 100 + i, closedAt: from + i * step + step - 1 }))

const identity = (over: Record<string, unknown> = {}) => ({
  assetKey: 'bip122:native:BTC', symbol: 'BTC', cexVerified: true, cmcId: '1', klineIdentity: false, coingeckoId: false, ...over,
}) as Parameters<typeof loadMarketCandles>[0]

Deno.test('the exchange rung answers first and CoinMarketCap is never asked for it', async () => {
  let cmcCalls = 0
  const result = await loadMarketCandles(identity(), '7D', '1H', NOW, {
    exchange: () => Promise.resolve({ candles: candles(NOW - 168 * HOUR, HOUR, 168), source: 'binance', bestProvider: 'binance', bestPair: 'BTCUSDT' }),
    cmc: () => { cmcCalls += 1; return Promise.resolve({ candles: [] }) },
  })
  assertEquals(cmcCalls, 0)
  assertEquals(result.source, 'binance')
  assertEquals((result.ladder as Record<string, unknown>).interval, '1H')
  assertEquals(result.candles.length, 168)
})

Deno.test('a silent exchange falls through to CoinMarketCap OHLCV with both reasons recorded', async () => {
  const result = await loadMarketCandles(identity(), '3M', '1D', NOW, {
    exchange: () => Promise.resolve({ candles: [], sourceReason: 'no_exchange_listing' }),
    cmc: (id) => Promise.resolve({ candles: candles(NOW - 90 * DAY, DAY, 90), source: 'coinmarketcap', bestProvider: 'coinmarketcap', coverage: `id ${id}` }),
  })
  assertEquals(result.source, 'coinmarketcap')
  assertEquals(result.candles.length, 90)
  assertEquals((result.ladder as Record<string, string[]>).sourcesTried, ['exchange', 'cmc_ohlcv'])
  assertStringIncludes(result.coverage as string, 'exchange:no_exchange_listing')
})

Deno.test('a long range merges the stored archive under the provider window and says how much came from it', async () => {
  const dayStart = Math.floor((NOW - 30 * DAY) / DAY) * DAY
  let archiveArgs: unknown[] = []
  const result = await loadMarketCandles(identity(), 'ALL', '1D', NOW, {
    exchange: () => Promise.resolve({ candles: candles(dayStart, DAY, 30), source: 'binance', bestProvider: 'binance' }),
    cmc: () => Promise.resolve({ candles: [] }),
    archive: (...args) => {
      archiveArgs = args
      return Promise.resolve({ bars: candles(dayStart - 4000 * DAY, DAY, 4000), reason: null, truncated: false })
    },
  })
  assertEquals(archiveArgs[0], 'bip122:native:BTC')
  assertEquals(archiveArgs[1], '1D')
  assertEquals(result.candles.length, 4030)
  const ladder = result.ladder as Record<string, unknown>
  assertEquals(ladder.archivedCandles, 4000)
  assertEquals(ladder.range, 'ALL')
  assertStringIncludes(result.coverage as string, '4000 of 4030 candles come from the stored daily archive')
})

Deno.test('a short range never reads the archive, so a minute chart cannot be padded with daily rows', async () => {
  let archiveCalls = 0
  await loadMarketCandles(identity(), '24H', '15M', NOW, {
    exchange: () => Promise.resolve({ candles: candles(NOW - 96 * 900_000, 900_000, 96), source: 'binance' }),
    archive: () => { archiveCalls += 1; return Promise.resolve({ bars: [], reason: null, truncated: false }) },
  })
  assertEquals(archiveCalls, 0)
})

Deno.test('no source and no archive is an explained emptiness, never a fabricated series', async () => {
  const result = await loadMarketCandles(identity({ cexVerified: false, cmcId: null }), '1Y', '1D', NOW, {})
  assertEquals(result.candles, [])
  assertEquals(result.sourceState, 'unavailable')
  assertEquals(result.sourceReason, 'no_candle_source')
  assertStringIncludes(result.coverage as string, 'no candle source could be asked')
})

Deno.test('a thrown rung is a reason and the walk continues instead of failing the chart', async () => {
  const result = await loadMarketCandles(identity(), '7D', '1H', NOW, {
    exchange: () => { throw new Error('socket closed') },
    cmc: () => Promise.resolve({ candles: candles(NOW - 168 * HOUR, HOUR, 168), source: 'coinmarketcap' }),
  })
  assertEquals(result.candles.length, 168)
  assertStringIncludes(result.coverage as string, 'exchange:provider_unavailable')
})

Deno.test('a failed archive read is reported and the live window is still drawn', async () => {
  const result = await loadMarketCandles(identity(), '2Y', '1D', NOW, {
    exchange: () => Promise.resolve({ candles: candles(NOW - 30 * DAY, DAY, 30), source: 'binance' }),
    archive: () => Promise.resolve({ bars: [], reason: 'permission denied for table', truncated: false }),
  })
  assertEquals(result.candles.length, 30)
  assertStringIncludes(result.coverage as string, 'The stored archive could not be read (permission denied for table).')
})
