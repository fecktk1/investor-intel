// The candle ladder: which width a (range, interval) pair resolves to, which
// source is asked in which order, what a bounded request can reach, and what the
// coverage sentence is obliged to say about all of it.

import { assertEquals, assertStringIncludes, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  autoInterval, candleCoverage, candlePlan, candleSourceOrder, CANDLE_RANGE_MS, isArchiveRange,
  nearestInterval, spanWords, VENUE_CANDLES, CMC_INTERVAL_KEYS,
} from './candle-ladder.ts'
import { archiveBar, archiveBars, archiveCanAnswer, ARCHIVE_PAGE_ROWS, ARCHIVE_ROW_CAP, archiveSeries, mergeCandles, readArchiveCandles, STORED_INTERVALS } from './candle-archive.ts'
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

// ─── warm-up (lookback) ───────────────────────────────────────────────────────

Deno.test('a warm-up is granted in full when the source ceiling has room for it', () => {
  const plan = candlePlan('1M', '4H', VENUE_CANDLES.binance, NOW, 50)
  // The WINDOW is still the window: coverage sentences count the periods the
  // reader asked for, not the bars fetched to warm an indicator up.
  assertEquals(plan.wanted, 180)
  assertEquals(plan.lookback, 50)
  assertEquals(plan.from, plan.to - 230 * plan.step)
  assertEquals(plan.limit, 231)
  assertEquals(plan.capped, false)
  assertEquals(plan.reachesFrom, plan.to - 230 * plan.step)
  // No warm-up asked for is the plan that existed before warm-ups did.
  const plain = candlePlan('1M', '4H', VENUE_CANDLES.binance, NOW)
  assertEquals(plain.lookback, 0)
  assertEquals(plain.from, plain.to - 180 * plain.step)
  assertEquals(plain.limit, 181)
})

Deno.test('the window is never short-changed by a warm-up: it takes only what the ceiling has left', () => {
  // Coinbase returns 300 rows. 7 days of hourly candles is 168 periods plus the
  // one in progress, so 131 warm-up periods fit and 500 do not.
  const partial = candlePlan('7D', '1H', VENUE_CANDLES.coinbase, NOW, 500)
  assertEquals(partial.wanted, 168)
  assertEquals(partial.lookback, 131)
  assertEquals(partial.limit, 300)
  assertEquals(partial.from, partial.to - 299 * partial.step)
  assertEquals(partial.capped, false)
  // Kraken returns 720 rows and 1 month of hourly candles needs all 720: there
  // is no room at all, and the window keeps every period it had.
  const none = candlePlan('1M', '1H', VENUE_CANDLES.kraken, NOW, 200)
  assertEquals(none.wanted, 720)
  assertEquals(none.lookback, 0)
  assertEquals(none.from, none.to - 720 * none.step)
  assertEquals(none.limit, 720)
})

Deno.test('a warm-up changes neither what capped means nor how far a capped request reaches', () => {
  const plain = candlePlan('1Y', '1M', VENUE_CANDLES.binance, NOW)
  const asked = candlePlan('1Y', '1M', VENUE_CANDLES.binance, NOW, 500)
  // A window that already exceeds the ceiling gets no warm-up, so the two plans
  // are the same plan.
  assertEquals(asked.lookback, 0)
  assertEquals(asked.capped, plain.capped)
  assertEquals(asked.reachesFrom, plain.reachesFrom)
  assertEquals(asked.from, plain.from)
  assertEquals(asked.limit, plain.limit)
  // A warm-up that fits moves `reachesFrom` back with the request and leaves
  // `capped` alone, because the range itself still fits.
  const room = candlePlan('7D', '1H', VENUE_CANDLES.binance, NOW, 60)
  assertEquals(room.capped, false)
  assertEquals(room.reachesFrom, room.to - 228 * room.step)
})

Deno.test('a warm-up that is not a whole count of periods is no warm-up, never a thrown chart', () => {
  for (const value of [-10, Number.NaN, Number.POSITIVE_INFINITY, undefined as unknown as number]) {
    assertEquals(candlePlan('7D', '1H', VENUE_CANDLES.binance, NOW, value).lookback, 0)
  }
  // A fractional request is truncated rather than rounded into an extra period.
  assertEquals(candlePlan('7D', '1H', VENUE_CANDLES.binance, NOW, 12.9).lookback, 12)
})

Deno.test('a series that covers the whole range but not its warm-up is not announced as a short range', () => {
  const plan = candlePlan('7D', '1H', VENUE_CANDLES.binance, NOW, 60)
  const windowFrom = plan.to - plan.wanted * plan.step
  const covered = candleCoverage({ plan, source: 'binance', oldest: windowFrom, count: 168 })
  assertEquals(covered.includes('reach back about'), false)
  // A series that does not even reach the window start still says so.
  const short = candleCoverage({ plan, source: 'binance', oldest: plan.to - 24 * HOUR, count: 24 })
  assertStringIncludes(short, 'They reach back about 1 day, not the full 7D range.')
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
  const mapped = exchangeBars([
    kline(NOW - 3 * step, step, 100),
    kline(NOW - 2 * step, step, 101, { volumeBase: 0 }),
    kline(NOW - step, step, 102, { committed: false }),
    kline(NOW, step, 103, { close: 'not a number' }),
    { openTime: 'x', closeTime: NOW },
  ], NOW)
  assertEquals(mapped.bars.length, 2)
  assertEquals(mapped.bars[0].c, 100)
  // A period in which nothing traded is a real zero, not a missing value.
  assertEquals(mapped.bars[1].v, 0)
  // No venue quote turnover on these rows, so the unit is named as the base asset
  // rather than relabelled.
  assertEquals(mapped.volumeUnit, 'base asset')
})

Deno.test('the exchange rung reports the unit its volume is actually in', () => {
  const step = HOUR
  const quoted = exchangeBars([
    kline(NOW - 2 * step, step, 100, { volumeBase: 3, volumeQuote: 300 }),
    kline(NOW - step, step, 101, { volumeBase: 0, volumeQuote: 0 }),
  ], NOW)
  // The quote turnover is preferred: it is the unit the stored archive and the
  // CoinMarketCap series use, so a merged chart carries one honest label.
  assertEquals(quoted.volumeUnit, 'quote asset')
  assertEquals(quoted.bars.map((bar) => bar.v), [300, 0])
  // Half a series with quote turnover is not a quote series: the base figure is
  // used for all of it rather than mixing two units under one label.
  const mixed = exchangeBars([
    kline(NOW - 2 * step, step, 100, { volumeBase: 3, volumeQuote: 300 }),
    kline(NOW - step, step, 101, { volumeBase: 4, volumeQuote: null }),
  ], NOW)
  assertEquals(mixed.volumeUnit, 'base asset')
  assertEquals(mixed.bars.map((bar) => bar.v), [3, 4])
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
  // These fixture klines carry no quote turnover, so the unit says base asset.
  assertEquals(result.volumeUnit, 'base asset')
  assertStringIncludes(result.coverage, 'Volume is the base asset for each completed period')
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

Deno.test('the exchange rung asks its venue for the warm-up as well as the window', async () => {
  const step = HOUR
  let asked = ''
  const start = Math.floor(NOW / step) * step - 228 * step
  const result = await loadExchangeCandles({}, 'BTC', '7D', '1H', NOW, {
    tickers: () => Promise.resolve([{ provider: 'binance', provider_symbol: 'BTCUSDT', quote_asset: 'USDT', volume_quote_24h: 1 }]),
    provider: () => ({
      getKlines: (_s: string, interval: string, limit: number) => {
        asked = `${interval}:${limit}`
        return Promise.resolve(Array.from({ length: 228 }, (_, i) => kline(start + i * step, step, 100 + i)))
      },
    }),
  }, 60)
  // 168 window periods plus 60 warm-up periods plus the one in progress.
  assertEquals(asked, '1h:229')
  assertEquals(result.plan?.lookback, 60)
  // The warm-up bars are KEPT: they are what the first visible bar's study needs.
  assertEquals(result.candles.length, 228)
  assertEquals(result.candles[0].t, start)
  // A complete range is not reported as a short one because the venue had no
  // more warm-up to give.
  assertEquals(result.coverage.includes('not the full 7D range'), false)
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

Deno.test('every rung is asked for the same warm-up and the archive window is extended by it', async () => {
  let exchangeArgs: unknown[] = [], cmcArgs: unknown[] = [], archiveArgs: unknown[] = []
  const result = await loadMarketCandles(identity(), '1Y', '1D', NOW, {
    exchange: (...args) => { exchangeArgs = args; return Promise.resolve({ candles: [], sourceReason: 'no_exchange_listing' }) },
    cmc: (...args) => { cmcArgs = args; return Promise.resolve({ candles: candles(NOW - 365 * DAY, DAY, 365), source: 'coinmarketcap' }) },
    archive: (...args) => { archiveArgs = args; return Promise.resolve({ bars: [], reason: null, truncated: false }) },
  }, 60)
  assertEquals(exchangeArgs, ['1Y', '1D', 60])
  assertEquals(cmcArgs, ['1', '1Y', '1D', 60])
  // The archive is read for the warm-up too: a study on a long range must warm
  // up on the same series the chart is drawn from.
  assertEquals(archiveArgs[2], NOW - CANDLE_RANGE_MS['1Y'] - 60 * DAY)
  assertEquals(archiveArgs[3], NOW)
  assertEquals(result.candles.length, 365)
})

Deno.test('the k-line and CoinGecko rungs receive the warm-up as well', async () => {
  let klineArgs: unknown[] = [], geckoArgs: unknown[] = []
  await loadMarketCandles(identity({ cexVerified: false, cmcId: null, klineIdentity: true, coingeckoId: true }), '7D', '1H', NOW, {
    kline: (...args) => { klineArgs = args; return Promise.resolve({ candles: [], sourceReason: 'no_completed_candles' }) },
    // The CoinGecko rung is bound to its timeframe by its caller, so the warm-up
    // is the only thing it is handed.
    coingecko: (...args) => { geckoArgs = args; return Promise.resolve({ candles: candles(NOW - 168 * HOUR, HOUR, 168), source: 'coingecko' }) },
  }, 120)
  assertEquals(klineArgs, ['7D', '1H', 120])
  assertEquals(geckoArgs, [120])
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

// ─── the archive read is paged ────────────────────────────────────────────────

/** A PostgREST stand-in with THIS PROJECT'S `max_rows = 1000`: it honours
 * `.range()` but never returns more than a thousand rows for one request, the
 * way the real server silently does. */
function pagedDb(total: number, cap = 1000) {
  const requests: [number, number][] = []
  const rows = Array.from({ length: total }, (_, index) => ({
    asset_key: 'bip122:native:BTC', provider: 'binance', candle_interval: '1d',
    candle_time: new Date(Date.UTC(2006, 0, 1) + index * DAY).toISOString(),
    open: 1, high: 2, low: 0.5, close: 1 + index, volume: 10, source_ref: 'binance:BTCUSDT:volume_quote_USDT',
    recorded_at: new Date(NOW).toISOString(),
  }))
  const builder: Record<string, unknown> = {
    select: () => builder, eq: () => builder, gte: () => builder, lte: () => builder, order: () => builder,
    range: (from: number, to: number) => {
      requests.push([from, to])
      const size = Math.min(to - from + 1, cap)
      return Promise.resolve({ data: rows.slice(from, from + size), error: null })
    },
  }
  return { db: { from: () => builder }, requests }
}

Deno.test('the archive read PAGES: a window wider than the server row ceiling is not silently truncated', async () => {
  // `max_rows = 1000` in supabase/config.toml is applied silently, so a single
  // `.limit(9000)` returned the OLDEST thousand days of a five-year window and
  // reported no truncation at all.
  assertEquals(ARCHIVE_PAGE_ROWS, 1000)
  const { db, requests } = pagedDb(3316)
  const read = await readArchiveCandles(db, 'bip122:native:BTC', '1D', Date.UTC(2006, 0, 1), NOW)
  assertEquals(read.rows, 3316)
  assertEquals(read.bars.length, 3316)
  assertEquals(read.truncated, false)
  assertEquals(read.reason, null)
  // Four requests: three full pages and a short one that ends the walk.
  assertEquals(requests, [[0, 999], [1000, 1999], [2000, 2999], [3000, 3999]])
  // The newest stored day is the last bar, not the thousandth.
  assertEquals(read.bars.at(-1)!.t, Date.UTC(2006, 0, 1) + 3315 * DAY)
})

Deno.test('a window that exhausts the total row cap is reported as truncated rather than short', async () => {
  const { db, requests } = pagedDb(ARCHIVE_ROW_CAP + 500)
  const read = await readArchiveCandles(db, 'bip122:native:BTC', '1D', Date.UTC(2006, 0, 1), NOW)
  assertEquals(read.rows, ARCHIVE_ROW_CAP)
  assertEquals(read.truncated, true)
  assertEquals(requests.length, ARCHIVE_ROW_CAP / ARCHIVE_PAGE_ROWS)
})

Deno.test('a short first page ends the walk without a second request', async () => {
  const { db, requests } = pagedDb(12)
  const read = await readArchiveCandles(db, 'bip122:native:BTC', '1D', Date.UTC(2006, 0, 1), NOW)
  assertEquals(read.rows, 12)
  assertEquals(read.truncated, false)
  assertEquals(requests, [[0, 999]])
})

Deno.test('a long merged range reports the archive ending at the NEWEST stored day', async () => {
  const { db } = pagedDb(3316)
  const result = await loadMarketCandles(identity(), '5Y', '1D', NOW, {
    exchange: () => Promise.resolve({ candles: [], sourceReason: 'no_exchange_listing' }),
    cmc: () => Promise.resolve({ candles: [] }),
    archive: (assetKey, interval, from, to) => archiveSeriesFor(db, assetKey, interval, from, to),
  })
  const ladder = result.ladder as Record<string, unknown>
  assertEquals(ladder.archivedCandles, 3316)
  assertEquals(String(ladder.archiveEndsAt).slice(0, 10), new Date(Date.UTC(2006, 0, 1) + 3315 * DAY).toISOString().slice(0, 10))
  // One unit runs through the whole series, and the sentence says so.
  assertEquals(result.volumeUnit, 'USD')
  assertStringIncludes(result.coverage as string, 'Archived volume is USD for every period')
})
// deno-lint-ignore no-explicit-any
const archiveSeriesFor = (db: any, assetKey: string, interval: string, from: number, to: number) =>
  readArchiveCandles(db, assetKey, interval, from, to).then((read) => ({ ...read, incomplete: 0 }))

Deno.test('an archive longer than the renderer ceiling keeps EVERY stored day, so the weekly series starts at the first stored week', async () => {
  // Bitcoin holds 5,907 daily rows (2010-07-14 onward). Passing them through
  // the renderer gate sliced them to the newest 5,000 and the ALL chart began
  // in 2013 with a complete 2010 archive underneath it.
  const { db } = pagedDb(5907)
  const read = await readArchiveCandles(db, 'bip122:native:BTC', '1D', Date.UTC(2006, 0, 1), NOW)
  assertEquals(read.rows, 5907)
  assertEquals(read.bars.length, 5907)
  assertEquals(read.bars[0].t, Date.UTC(2006, 0, 1))
  const weekly = await archiveSeries(db, 'bip122:native:BTC', '1W', Date.UTC(2006, 0, 1), NOW, NOW)
  // 2006-01-02 is the first Monday after the first stored day.
  assertEquals(weekly.bars[0].t, Date.UTC(2006, 0, 2))
  assertEquals(weekly.bars.length > 800, true)
  // The bar builder itself keeps one bar per period, oldest first, and drops a
  // row that has no positive close.
  const bars = archiveBars([
    { candle_time: '2020-01-02T00:00:00.000Z', close: 2, recorded_at: '2020-01-03T00:00:00.000Z' },
    { candle_time: '2020-01-01T00:00:00.000Z', close: 1, recorded_at: '2020-01-02T00:00:00.000Z' },
    { candle_time: '2020-01-03T00:00:00.000Z', close: 0, recorded_at: '2020-01-04T00:00:00.000Z' },
  ], DAY)
  assertEquals(bars.map((bar) => bar.c), [1, 2])
})
