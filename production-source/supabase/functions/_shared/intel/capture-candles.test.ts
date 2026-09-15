// The candle history lane: where a year comes from, what it costs, what is
// stored, what is resumed, and what is refused.

import { assertEquals, assertStringIncludes, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  backfillAssetHistory, backfillCandidates, backfillOneAsset, candleRow, captureCandleBackfill,
  captureCandleDaily, ohlcvHistoryPages, CANDLE_CAPTURE_OPS, HISTORY_EPOCH_MS, OHLCV_MAX_PAGES,
  OHLCV_PAGE_COUNT, OHLCV_PAGE_DAYS, BACKFILL_CREDIT_CEILING, cmcCatalogueIndex, cmcIdOf,
} from './capture-candles.ts'
import { binanceDailyBar, binanceDailyHistory, BINANCE_EPOCH_MS } from './exchange-history.ts'
import { readCandleCoverage } from './capture-candles-read.ts'
import { cmcParams, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 8, 15, 12, 0, 0)
const YESTERDAY = Math.floor(NOW / DAY) * DAY - DAY
const KEY = 'bip122:native:BTC'

// ─── a tiny PostgREST-shaped stand-in ─────────────────────────────────────────

interface Store { [table: string]: Record<string, unknown>[] }
function fakeDb(store: Store, fail: Record<string, string> = {}) {
  const writes: { table: string; rows: Record<string, unknown>[]; onConflict?: string }[] = []
  const updates: { table: string; patch: Record<string, unknown>; match: Record<string, unknown> }[] = []
  const make = (table: string) => {
    const filters: [string, unknown][] = []
    let inFilter: [string, unknown[]] | null = null
    const builder: Record<string, unknown> = {
      select: () => builder, eq: (k: string, v: unknown) => { filters.push([k, v]); return builder },
      gt: () => builder, not: () => builder,
      in: (k: string, v: unknown[]) => { inFilter = [k, v]; return builder },
      order: () => builder,
      limit: (n?: number) => {
        if (fail[table]) return Promise.resolve({ data: null, error: { message: fail[table] } })
        let rows = store[table] || []
        for (const [k, v] of filters) rows = rows.filter((row) => String(row[k]) === String(v))
        if (inFilter) rows = rows.filter((row) => (inFilter as [string, unknown[]])[1].map(String).includes(String(row[(inFilter as [string, unknown[]])[0]])))
        return Promise.resolve({ data: typeof n === 'number' ? rows.slice(0, n) : rows, error: null })
      },
      upsert: (rows: Record<string, unknown>[], options?: { onConflict?: string }) => {
        writes.push({ table, rows, onConflict: options?.onConflict })
        store[table] = [...(store[table] || []), ...rows]
        return Promise.resolve({ error: fail[`${table}:write`] ? { message: fail[`${table}:write`] } : null })
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (k: string, v: unknown) => {
          updates.push({ table, patch, match: { [k]: v } })
          store[table] = (store[table] || []).map((row) => String(row[k]) === String(v) ? { ...row, ...patch } : row)
          return Promise.resolve({ error: null })
        },
      }),
    }
    return builder
  }
  return { db: { from: (table: string) => make(table) }, writes, updates, store }
}

const ctxFor = () => ({ kind: 'job' as const })
/** A real `/api/v3/klines` row, in the documented order and with the documented
 * string types: open time, O, H, L, C, BASE volume, close time, QUOTE volume,
 * trades, taker base, taker quote, ignore. */
const kline = (t: number, close: number, base: number | string | null = 10, quote: number | string | null = 600_000) =>
  [t, String(close - 1), String(close + 1), String(close - 2), String(close), base == null ? null : String(base),
    t + DAY - 1, quote == null ? null : String(quote), 812, '5.0', '300000.0', '0']

// ─── Binance history ──────────────────────────────────────────────────────────

Deno.test('a Binance daily row becomes a candle only when it is a completed UTC day', () => {
  const bar = binanceDailyBar(kline(YESTERDAY, 100), NOW)!
  assertEquals(bar.t, YESTERDAY)
  assertEquals(bar.closedAt, YESTERDAY + DAY - 1)
  // The venue publishes strings; they become numbers, not NaN.
  assertEquals([bar.o, bar.h, bar.l, bar.c], [99, 101, 98, 100])
  // A day that has not closed is not a candle.
  assertEquals(binanceDailyBar(kline(YESTERDAY + DAY, 100), NOW), null)
  // A row whose open time is not on a UTC day boundary is not a daily candle.
  assertEquals(binanceDailyBar(kline(YESTERDAY + 3600_000, 100), NOW), null)
  assertEquals(binanceDailyBar('not a row', NOW), null)
})

Deno.test('the stored Binance volume is the QUOTE turnover, so the archive is one unit', () => {
  // Field 7, not field 5. CoinMarketCap OHLCV rows beside these are in USD, and
  // `binancePair` picks the pair with the most quote volume, which is a USD
  // stablecoin; storing the base-asset amount would put two units in one column.
  const bar = binanceDailyBar(kline(YESTERDAY, 60_000, '2.5', '150000.0'), NOW)!
  assertEquals(bar.v, 150_000)
  assertEquals(bar.volumeUnit, 'USD')
  // A day in which nothing traded is a real zero.
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100, '0', '0'), NOW)!.v, 0)
  // An unreported quote turnover stays NULL; the base figure is never used in
  // its place, because that would be a different unit under the same label.
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100, '7', null), NOW)!.v, null)
  // A row too short to carry field 7 has no quote turnover at all.
  assertEquals(binanceDailyBar([YESTERDAY, '1', '2', '0.5', '1.5', '9', YESTERDAY + DAY - 1], NOW)!.v, null)
})

Deno.test('Binance history pages forward and only a short page proves it saw the first day', async () => {
  const first = Date.UTC(2017, 7, 17)
  const paths: string[] = []
  const history = await binanceDailyHistory({}, 'BTCUSDT', BINANCE_EPOCH_MS, YESTERDAY + DAY - 1, NOW, {
    call: (_p: unknown, opts: { path: string }) => {
      paths.push(opts.path)
      const start = Number(new URL(`https://x${opts.path}`).searchParams.get('startTime'))
      const from = Math.max(start, first)
      const rows = []
      for (let t = from; t <= YESTERDAY && rows.length < 1000; t += DAY) rows.push(kline(t, 100))
      return Promise.resolve({ ok: true, status: 200, data: rows })
    },
  })
  assertEquals(history.complete, true)
  assertEquals(history.bars[0].t, first)
  assertEquals(history.bars.at(-1)!.t, YESTERDAY)
  assertEquals(paths.length >= 3, true)
  assertStringIncludes(paths[0], 'interval=1d')
})

Deno.test('a venue outage is a reason and an incomplete walk, not a claimed first day', async () => {
  const history = await binanceDailyHistory({}, 'BTCUSDT', BINANCE_EPOCH_MS, YESTERDAY, NOW, {
    call: () => Promise.resolve({ ok: false, status: 503, data: null }),
  })
  assertEquals(history.bars, [])
  assertEquals(history.complete, false)
  assertEquals(history.reason, 'venue_unavailable')
})

// ─── OHLCV paging and credits ─────────────────────────────────────────────────

Deno.test('every OHLCV page the lane builds is accepted by the REAL registry validator', () => {
  // The registry caps `count` at 250 for this capability (`numericCeiling` in
  // cmc-capabilities.ts). A page that asks for more is refused by `cmcParams`
  // BEFORE any request leaves the process, which is exactly how a live seed run
  // spent nothing and stored nothing. The validator is exercised here rather
  // than mocked, so a future change to either side breaks this test.
  assertEquals(OHLCV_PAGE_COUNT, 250)
  assertEquals(OHLCV_PAGE_DAYS, 249)
  assertThrows(() => cmcParams('ohlcv', { id: '1', time_period: 'daily', interval: 'daily', time_start: '2010-01-01T00:00:00.000Z', time_end: '2012-09-26T00:00:00.000Z', count: 1001 }),
    Error, 'invalid_parameter:count')
  for (const window of [[Date.UTC(2010, 0, 1), Date.UTC(2017, 7, 17)], [Date.UTC(2013, 3, 28), Date.UTC(2026, 8, 15)], [HISTORY_EPOCH_MS, Date.UTC(2026, 8, 15)]]) {
    const pages = ohlcvHistoryPages('1', window[0], window[1])
    assertEquals(pages.length > 0, true)
    for (const page of pages) {
      const params = cmcParams('ohlcv', page)
      assertEquals(params.id, '1')
      assertEquals(params.interval, 'daily')
      assertEquals(params.time_period, 'daily')
      assertEquals(Number(params.count) >= 1 && Number(params.count) <= OHLCV_PAGE_COUNT, true)
      // A real credit estimate, from the same params the transport would send.
      // A full page is 3 credits; only the last, partial page can be cheaper.
      const cost = estimateCmcCredits('ohlcv', params)
      assertEquals(cost >= 1 && cost <= 3, true, `cost=${cost}`)
      assertEquals(page === pages.at(-1) || cost === 3, true, 'every full page costs the same three credits')
    }
  }
})

Deno.test('a full history walk fits inside the page ceiling and its credits are the documented rate', () => {
  // 2010 to today is about 6,100 days: 25 pages of 249, inside the 26-page
  // ceiling, so a full walk is never cut short by the ceiling alone.
  const full = ohlcvHistoryPages('1', HISTORY_EPOCH_MS, Date.UTC(2026, 8, 15))
  assertEquals(full.length, 25)
  assertEquals(full.length < OHLCV_MAX_PAGES, true)
  const credits = full.reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0)
  assertEquals(credits, 74)
  // Bitcoin's pre-Binance gap, which is all the paid rung ever owes for it.
  const gap = ohlcvHistoryPages('1', Date.UTC(2013, 3, 28), Date.UTC(2017, 7, 17))
  assertEquals(gap.reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0), 19)
  // Nothing before the epoch is ever asked for, and an empty window asks nothing.
  assertEquals(Date.parse(String(full.at(-1)!.time_start)) >= HISTORY_EPOCH_MS - 1, true)
  assertEquals(ohlcvHistoryPages('1', Date.UTC(2026, 8, 15), Date.UTC(2026, 8, 15)).length, 0)
})

Deno.test('the top 100 is held to the standing ceiling, and a realistic cohort fits inside it', () => {
  const to = Date.UTC(2026, 8, 15)
  const credits = (from: number) => ohlcvHistoryPages('1', from, to).reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0)
  // A five-year median history for every one of the hundred is well inside the
  // standing budget, even before the free venue removes most of it.
  assertEquals(credits(to - 5 * 365 * DAY) * 100 < BACKFILL_CREDIT_CEILING, true, `median ${credits(to - 5 * 365 * DAY) * 100}`)
  // A cohort that ALL needed their whole history from the paid rung would exceed
  // it, which is precisely why the ceiling is standing rather than per run: the
  // lane stops at 5,000 instead of discovering the overrun on the invoice.
  assertEquals(credits(HISTORY_EPOCH_MS) * 100 > BACKFILL_CREDIT_CEILING, true)
  assertEquals(BACKFILL_CREDIT_CEILING, 5000)
})

// ─── one asset ────────────────────────────────────────────────────────────────

Deno.test('a candle row is aligned, keeps a zero volume and refuses a bar with no close', () => {
  const row = candleRow(KEY, 'binance', { t: YESTERDAY, c: 100, o: 99, h: 101, l: 98, v: 0 }, 'binance:BTCUSDT', new Date(NOW).toISOString())!
  assertEquals(row.candle_interval, '1d')
  assertEquals(row.candle_time, new Date(YESTERDAY).toISOString())
  assertEquals(row.volume, 0)
  assertEquals(candleRow(KEY, 'binance', { t: YESTERDAY, c: null }, null, '')!, null)
  // A bar that is not on a day boundary is not a daily candle.
  assertEquals(candleRow(KEY, 'binance', { t: YESTERDAY + 60_000, c: 1 }, null, ''), null)
  // An unreported volume is stored as NULL, never as zero.
  assertEquals(candleRow(KEY, 'binance', { t: YESTERDAY, c: 1, v: null }, null, '')!.volume, null)
})

const ohlcvPayload = (id: string, from: number, count: number) => ({
  data: {
    id: Number(id), quotes: Array.from({ length: count }, (_, i) => ({
      time_open: new Date(from + i * DAY).toISOString(),
      time_close: new Date(from + i * DAY + DAY - 1).toISOString(),
      quote: { USD: { open: 10 + i, high: 12 + i, low: 9 + i, close: 11 + i, volume: 1000 + i } },
    })),
  },
})

Deno.test('an asset on a free venue costs nothing and the paid rung only buys the years before the listing', async () => {
  const listed = Date.UTC(2017, 7, 17)
  const { db } = fakeDb({ exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }] })
  const asked: Record<string, unknown>[] = []
  const result = await backfillAssetHistory(db, { assetKey: KEY, symbol: 'BTC', cmcId: '1' }, {}, NOW, 400, {
    request: (_name, params) => { asked.push(params!); return Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 40), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    exchange: () => Promise.resolve({
      bars: [{ t: listed, c: 4000, closedAt: listed + DAY - 1 }, { t: YESTERDAY, c: 60000, closedAt: YESTERDAY + DAY - 1 }],
      pages: 2, reason: null, complete: true,
    }),
  })
  assertEquals(result.source, 'binance+coinmarketcap')
  // Every paid page ends at or before the venue's first day: the free years are
  // never bought a second time.
  assertEquals(asked.length > 0, true)
  for (const params of asked) assertEquals(Date.parse(String(params.time_end)) <= listed, true)
  assertEquals(result.credits > 0, true)
  assertEquals(result.rows > 2, true)
})

Deno.test('a venue-only asset spends no credits at all', async () => {
  const { db, writes } = fakeDb({ exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'XYZUSDT', normalized_symbol: 'XYZ', quote_asset: 'USDT', volume_quote_24h: 1 }] })
  let requests = 0
  const result = await backfillAssetHistory(db, { assetKey: 'market:coingecko:xyz', symbol: 'XYZ', cmcId: null }, {}, NOW, 400, {
    request: () => { requests += 1; return Promise.resolve(null) },
    exchange: () => Promise.resolve({ bars: [{ t: YESTERDAY, c: 1, closedAt: YESTERDAY + DAY - 1 }], pages: 1, reason: null, complete: true }),
  })
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
  assertEquals(result.complete, true)
  assertEquals(writes[0].onConflict, 'asset_key,provider,candle_interval,candle_time')
  // The stored reference NAMES the unit, so a reader of the table never infers it.
  assertEquals(writes[0].rows[0].source_ref, 'binance:XYZUSDT:volume_quote_USDT')
})

Deno.test('an asset with neither a venue nor a listing is recorded as unavailable with a reason', async () => {
  const { db } = fakeDb({ exchange_latest_tickers: [] })
  const result = await backfillAssetHistory(db, { assetKey: 'market:contract:x', symbol: null, cmcId: null }, {}, NOW, 400, { request: () => Promise.resolve(null) })
  assertEquals(result.rows, 0)
  assertEquals(result.reason, 'no_cmc_listing')
  assertEquals(result.complete, false)
})

Deno.test('a spent credit budget stops the walk and is reported rather than silently truncating history', async () => {
  const { db } = fakeDb({ exchange_latest_tickers: [] })
  const result = await backfillAssetHistory(db, { assetKey: KEY, symbol: 'BTC', cmcId: '1' }, {}, NOW, 1, {
    request: () => Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 10), provenance: {} }),
  })
  assertEquals(result.reason, 'credit_budget')
  assertEquals(result.complete, false)
})

// ─── the ops ──────────────────────────────────────────────────────────────────

Deno.test('the queue is the ranked cohort plus everything a reader opened, merged on the asset key', () => {
  const rows = backfillCandidates(
    [{ source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', normalized_symbol: 'BTC', market_cap_rank: 1, platforms: {} },
      { source_provider: 'coinmarketcap', provider_id: '1027', symbol: 'ETH', normalized_symbol: 'ETH', market_cap_rank: 2, platforms: {} }],
    [{ asset_key: 'bip122:native:BTC', provider: 'coinmarketcap', provider_id: '1' },
      { asset_key: 'solana:So11111111111111111111111111111111111111112', provider: 'contract', provider_id: 'solana:x' }],
    NOW,
  )
  assertEquals(rows.length, 3)
  const btc = rows.find((row) => row.asset_key === 'bip122:native:BTC')!
  // The ranked entry wins: a demanded asset that is also ranked keeps its rank.
  assertEquals(btc.priority, 1)
  assertEquals(btc.symbol, 'BTC')
  // A demanded asset with no rank still queues, behind the cohort.
  assertEquals(rows.find((row) => row.asset_key.toString().startsWith('solana:'))!.priority, 101)
  assertEquals(rows.every((row) => row.state === 'pending'), true)
})

Deno.test('a disabled policy stops the lane without a single provider call', async () => {
  const { db } = fakeDb({})
  let requests = 0
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => { requests += 1; return Promise.resolve(null) },
    policy: [{ provider: 'coinmarketcap', feature: 'candle_history', cadence_seconds: 1200, enabled: false }],
  })
  assertEquals(result.skipped, 'policy_disabled')
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
})

Deno.test('the backfill obeys the standing credit ceiling in the policy row', async () => {
  const { db } = fakeDb({
    market_assets: [], market_asset_demand: [], exchange_latest_tickers: [],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 4999, attempts: 0 }],
  })
  let requests = 0
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => { requests += 1; return Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 5), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    policy: [{ provider: 'coinmarketcap', feature: 'candle_history', cadence_seconds: 1200, enabled: true, max_credits: 5000 }],
  })
  assertEquals(result.creditCeiling, 5000)
  assertEquals(result.creditsSpentToDate, 4999)
  // One credit left is less than the three a page costs, so nothing is bought.
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
})

Deno.test('a run is bounded, resumable and records its progress so the next run never repeats it', async () => {
  const queue = Array.from({ length: 25 }, (_, i) => ({
    asset_key: `market:coinmarketcap:${i + 1}`, provider: 'coinmarketcap', provider_id: String(i + 1),
    symbol: `A${i}`, state: 'pending', priority: i + 1, candles: 0, credits_spent: 0, attempts: 0,
  }))
  const { db, updates } = fakeDb({ market_assets: [], market_asset_demand: [], exchange_latest_tickers: [], market_asset_candle_backfill: queue })
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => Promise.resolve({ payload: ohlcvPayload('1', YESTERDAY - 3 * DAY, 3), provenance: {} }),
    policy: [{ provider: 'coinmarketcap', feature: 'candle_history', cadence_seconds: 1200, enabled: true, max_credits: 5000 }],
  })
  // Ten assets a run, not twenty five.
  assertEquals(result.assets, 10)
  assertEquals(updates.length, 10)
  for (const update of updates) {
    assertEquals(typeof update.patch.last_attempt_at, 'string')
    assertEquals(update.patch.attempts, 1)
  }
})

Deno.test('below the Startup plan the free venue still fills the archive and nothing is bought', async () => {
  const { db } = fakeDb({
    market_assets: [], market_asset_demand: [],
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 0, attempts: 0 }],
  })
  let requests = 0
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'basic', {
    request: () => { requests += 1; return Promise.resolve(null) },
    exchange: () => Promise.resolve({ bars: [{ t: YESTERDAY, c: 60000, closedAt: YESTERDAY + DAY - 1 }], pages: 1, reason: null, complete: true }),
    policy: [],
  })
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
  assertEquals(result.rows, 1)
})

Deno.test('the daily append asks only for the days after the newest stored candle', async () => {
  const stored = new Date(YESTERDAY - 3 * DAY).toISOString().slice(0, 10)
  const asked: number[] = []
  const { db, updates } = fakeDb({
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', source: 'binance', state: 'complete', oldest_candle: '2017-08-17', newest_candle: stored, candles: 3000, credits_spent: 50, attempts: 1, completed_at: new Date(NOW - DAY).toISOString() }],
  })
  const result = await captureCandleDaily(db, ctxFor, new Date(NOW), 'startup', {
    request: () => Promise.resolve(null),
    exchange: (_c, _s, from) => { asked.push(from); return Promise.resolve({ bars: [{ t: YESTERDAY, c: 60000, closedAt: YESTERDAY + DAY - 1 }], pages: 1, reason: null, complete: true }) },
    policy: [],
  })
  assertEquals(result.appended, 1)
  // It resumed from the day after the stored candle, not from the epoch.
  assertEquals(asked[0], Date.parse(stored) + DAY)
  // The recorded window was extended, never narrowed to the appended day.
  assertEquals(updates[0].patch.oldest_candle, '2017-08-17')
  assertEquals(updates[0].patch.newest_candle, new Date(YESTERDAY).toISOString().slice(0, 10))
  assertEquals(updates[0].patch.state, 'complete')
})

Deno.test('the daily append does nothing when every stored asset already holds yesterday', async () => {
  const { db } = fakeDb({
    exchange_latest_tickers: [],
    market_asset_candle_backfill: [{ asset_key: KEY, symbol: 'BTC', state: 'complete', source: 'binance', oldest_candle: '2017-08-17', newest_candle: new Date(YESTERDAY).toISOString().slice(0, 10), candles: 10, credits_spent: 0, attempts: 1 }],
  })
  const result = await captureCandleDaily(db, ctxFor, new Date(NOW), 'startup', { request: () => Promise.resolve(null), policy: [] })
  assertEquals(result.skipped, 'nothing_due')
  assertEquals(result.credits, 0)
})

Deno.test('one named asset can be filled by hand and reports what it stored', async () => {
  const { db } = fakeDb({
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 0, attempts: 0 }],
  })
  const result = await backfillOneAsset(db, KEY, ctxFor, new Date(NOW), 'startup', {
    request: () => Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 30), provenance: {} }),
    exchange: () => Promise.resolve({ bars: [{ t: Date.UTC(2017, 7, 17), c: 4000, closedAt: Date.UTC(2017, 7, 17) + DAY - 1 }], pages: 1, reason: null, complete: true }),
    policy: [],
  })
  assertEquals(result.job, 'history_backfill')
  assertEquals(result.assetKey, KEY)
  assertEquals(result.oldest, '2013-04-28')
  assertEquals(result.rows > 30, true)
  assertEquals(result.source, 'binance+coinmarketcap')
})

Deno.test('an unknown asset key is refused rather than queued from a guess', async () => {
  const { db } = fakeDb({ market_asset_candle_backfill: [], market_asset_demand: [], market_assets: [] })
  assertEquals((await backfillOneAsset(db, '', ctxFor, new Date(NOW), 'startup', { request: () => Promise.resolve(null) })).error, 'invalid_asset_key')
  assertEquals((await backfillOneAsset(db, 'market:nowhere:0', ctxFor, new Date(NOW), 'startup', { request: () => Promise.resolve(null) })).error, 'asset_not_in_catalogue')
})

Deno.test('the lane exposes exactly the three ops the Edge Function wires', () => {
  assertEquals(Object.keys(CANDLE_CAPTURE_OPS).sort(), ['candle_backfill', 'candle_daily', 'history_backfill'])
})

Deno.test('a page the validator refuses costs nothing: credits are counted only for a request that reached the provider', async () => {
  const { db, updates } = fakeDb({
    exchange_latest_tickers: [],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 0, attempts: 0 }],
  })
  // This is what the live seed run did: the registry refused the page before any
  // call, and the lane still recorded credits for it.
  const refused = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => Promise.reject(new Error('invalid_parameter:count')),
    policy: [],
  })
  assertEquals(refused.credits, 0)
  assertEquals(updates[0].patch.credits_spent, 0)
  assertEquals(updates[0].patch.reason, 'provider_unavailable')

  // A provider that REPLIED without a payload has been reached, so its page is
  // counted: the estimate is a floor the transport reconciles, not an invention.
  const { db: db2 } = fakeDb({
    exchange_latest_tickers: [],
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 0, attempts: 0 }],
  })
  const reached = await captureCandleBackfill(db2, ctxFor, new Date(NOW), 'startup', {
    request: () => Promise.resolve({ payload: null, reason: 'rate_limited', provenance: { fetchedAt: new Date(NOW).toISOString() } }),
    policy: [],
  })
  assertEquals(reached.credits, 3)
})

Deno.test('a partial asset resumes BACKWARD from its oldest stored day and never re-asks a stored period', async () => {
  const storedOldest = Date.UTC(2017, 7, 17), storedNewest = YESTERDAY
  const asked: Record<string, unknown>[] = []
  let venueFrom = 0
  const { db, updates } = fakeDb({
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }],
    market_asset_candle_backfill: [{
      asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', source: 'binance', state: 'partial',
      oldest_candle: new Date(storedOldest).toISOString().slice(0, 10), newest_candle: new Date(storedNewest).toISOString().slice(0, 10),
      candles: 3316, credits_spent: 0, attempts: 1,
    }],
  })
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: (_name, params) => { asked.push(params!); return Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 30), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    exchange: (_c, _s, from) => { venueFrom = from; return Promise.resolve({ bars: [], pages: 1, reason: 'no_completed_candles', complete: true }) },
    policy: [],
  })
  // The venue still resumes FORWARD: its own walk pages forward, so its gap is
  // at the new end.
  assertEquals(venueFrom, storedNewest + DAY)
  // The paid rung pages BACKWARD: every page ends at or before the oldest stored
  // day, so no stored period is ever asked for again, and the walk reaches the
  // years an interrupted run still owes.
  assertEquals(asked.length > 0, true)
  for (const params of asked) {
    assertEquals(Date.parse(String(params.time_end)) <= storedOldest, true, `page ends ${params.time_end}`)
    assertEquals(Date.parse(String(params.time_start)) >= HISTORY_EPOCH_MS - 1, true)
  }
  assertEquals(Date.parse(String(asked[0].time_end)) > Date.parse(String(asked.at(-1)!.time_end)), true, 'the pages walk backwards')
  assertEquals(result.credits > 0, true)
  // The recorded window grew at the OLD end, and the asset is not falsely closed
  // out on a resume that bought nothing.
  assertEquals(updates[0].patch.oldest_candle, '2013-04-28')
  assertEquals(updates[0].patch.newest_candle, new Date(storedNewest).toISOString().slice(0, 10))
})

Deno.test("a complete asset's daily append never walks older years", async () => {
  const storedOldest = '2013-04-28', storedNewest = new Date(YESTERDAY - DAY).toISOString().slice(0, 10)
  const queue = () => [{
    asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', source: 'binance+coinmarketcap',
    state: 'complete', oldest_candle: storedOldest, newest_candle: storedNewest, candles: 4800, credits_spent: 60, attempts: 1,
    completed_at: new Date(NOW - DAY).toISOString(),
  }]

  // With a venue pair the append costs nothing at all: the venue covers the
  // missing day, so the paid rung has an empty window.
  const asked: Record<string, unknown>[] = []
  const { db } = fakeDb({
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'BTCUSDT', normalized_symbol: 'BTC', volume_quote_24h: 1 }],
    market_asset_candle_backfill: queue(),
  })
  const free = await captureCandleDaily(db, ctxFor, new Date(NOW), 'startup', {
    request: (_name, params) => { asked.push(params!); return Promise.resolve({ payload: ohlcvPayload('1', YESTERDAY, 1), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    exchange: (_c, _s, from) => Promise.resolve({ bars: [{ t: from, c: 60000, closedAt: from + DAY - 1 }, { t: YESTERDAY, c: 61000, closedAt: YESTERDAY + DAY - 1 }], pages: 1, reason: null, complete: true }),
    policy: [],
  })
  assertEquals(asked.length, 0, 'a Binance asset is appended for free')
  assertEquals(free.credits, 0)

  // Without a venue pair the append buys ONE short forward page, never the
  // decade it already holds.
  const paidAsks: Record<string, unknown>[] = []
  const { db: db2 } = fakeDb({ exchange_latest_tickers: [], market_asset_candle_backfill: queue() })
  const paid = await captureCandleDaily(db2, ctxFor, new Date(NOW), 'startup', {
    request: (_name, params) => { paidAsks.push(params!); return Promise.resolve({ payload: ohlcvPayload('1', Date.parse(storedNewest) + DAY, 2), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    policy: [],
  })
  assertEquals(paidAsks.length, 1, 'one short page, not a backward walk')
  assertEquals(paid.credits, 1)
  for (const params of paidAsks) {
    assertEquals(Date.parse(String(params.time_start)) >= Date.parse(storedNewest), true, 'the append never reaches behind the stored window')
    assertEquals(Number(params.count) <= OHLCV_PAGE_COUNT, true)
  }
})

Deno.test('a CoinGecko-sourced asset still resolves its CoinMarketCap id, by canonical identity or a unique ticker', () => {
  const index = cmcCatalogueIndex([
    { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', normalized_symbol: 'BTC', platforms: {} },
    { source_provider: 'coinmarketcap', provider_id: '52', symbol: 'XRP', normalized_symbol: 'XRP', platforms: {} },
    { source_provider: 'coinmarketcap', provider_id: '825', symbol: 'USDT', normalized_symbol: 'USDT', platforms: {} },
    // Two CoinMarketCap assets claim this ticker, so it resolves to neither.
    { source_provider: 'coinmarketcap', provider_id: '9001', symbol: 'GRASS', normalized_symbol: 'GRASS', platforms: {} },
    { source_provider: 'coinmarketcap', provider_id: '9002', symbol: 'GRASS', normalized_symbol: 'GRASS', platforms: {} },
  ])
  // 1. The resolver the chart itself uses, for a row it can read directly.
  assertEquals(cmcIdOf({ source_provider: 'coinmarketcap', provider_id: '1027' }, index), '1027')
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'usd-coin' }, index), '3408')
  // 2. The canonical identity: both providers' rows for Bitcoin are one asset.
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'bitcoin', normalized_symbol: 'BTC' }, index), '1')
  // 3. A ticker exactly one CoinMarketCap asset claims. This is what XRP and
  //    USDT need: a CoinGecko-sourced catalogue row with no canonical native key.
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'ripple', normalized_symbol: 'XRP' }, index), '52')
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'tether', normalized_symbol: 'USDT' }, index), '825')
  // An ambiguous ticker resolves to nothing rather than to a guess, and an asset
  // with no listing anywhere keeps its honest null.
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'grass', normalized_symbol: 'GRASS' }, index), null)
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'nothing', normalized_symbol: 'NOPE' }, index), null)
  assertEquals(cmcIdOf({ source_provider: 'coingecko', provider_id: 'ripple', normalized_symbol: 'XRP' }), null)
})

Deno.test('the seeded queue carries the resolved id, and the paid rung uses it for a CoinGecko-sourced asset', async () => {
  const catalogue = [{ source_provider: 'coingecko', provider_id: 'ripple', symbol: 'XRP', normalized_symbol: 'XRP', market_cap_rank: 4, platforms: {} }]
  const rows = backfillCandidates(catalogue, [], NOW, cmcCatalogueIndex([
    { source_provider: 'coinmarketcap', provider_id: '52', symbol: 'XRP', normalized_symbol: 'XRP', platforms: {} },
  ]))
  assertEquals(rows.length, 1)
  assertEquals(rows[0].provider, 'coingecko')
  assertEquals(rows[0].cmc_id, '52')

  // And the run spends its paid rung against that id rather than answering
  // 'no_cmc_listing' because the CATALOGUE row is not a CoinMarketCap one.
  const asked: Record<string, unknown>[] = []
  const { db, updates } = fakeDb({
    exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'XRPUSDT', normalized_symbol: 'XRP', quote_asset: 'USDT', volume_quote_24h: 1 }],
    market_asset_candle_backfill: [{ ...rows[0], state: 'pending', candles: 0, credits_spent: 0, attempts: 0 }],
  })
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: (_name, params) => { asked.push(params!); return Promise.resolve({ payload: ohlcvPayload('52', Date.UTC(2013, 7, 4), 20), provenance: { fetchedAt: new Date(NOW).toISOString() } }) },
    exchange: () => Promise.resolve({ bars: [{ t: Date.UTC(2018, 4, 4), c: 0.9, closedAt: Date.UTC(2018, 4, 4) + DAY - 1 }], pages: 1, reason: null, complete: true }),
    policy: [],
  })
  assertEquals(asked.length > 0, true)
  assertEquals(asked.every((params) => params.id === '52'), true)
  assertEquals(result.credits > 0, true)
  assertEquals(updates[0].patch.source, 'binance+coinmarketcap')
  assertEquals(updates[0].patch.reason, null)
  // The pre-venue years are stored, so the archive no longer starts in 2018.
  assertEquals(updates[0].patch.oldest_candle, '2013-08-04')
})

Deno.test('an asset that genuinely resolves to nothing keeps its no_cmc_listing reason', async () => {
  const { db, updates } = fakeDb({
    exchange_latest_tickers: [],
    market_asset_candle_backfill: [{ asset_key: 'market:coingecko:nothing', provider: 'coingecko', provider_id: 'nothing', cmc_id: null, symbol: 'NOPE', state: 'pending', priority: 101, candles: 0, credits_spent: 0, attempts: 0 }],
  })
  let requests = 0
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => { requests += 1; return Promise.resolve(null) },
    policy: [],
  })
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
  assertEquals(updates[0].patch.reason, 'no_cmc_listing')
  assertEquals(updates[0].patch.state, 'unavailable')
})

// ─── the read view ────────────────────────────────────────────────────────────

Deno.test('the coverage view totals what is stored and what is still owed', async () => {
  const { db } = fakeDb({
    market_asset_candle_backfill: [
      { asset_key: KEY, symbol: 'BTC', source: 'binance+coinmarketcap', state: 'complete', priority: 1, oldest_candle: '2013-04-28', newest_candle: '2026-09-14', candles: 4880, credits_spent: 50, attempts: 1, last_attempt_at: new Date(NOW).toISOString() },
      { asset_key: 'eip155:1:native', symbol: 'ETH', source: 'binance', state: 'partial', priority: 2, oldest_candle: '2017-08-17', newest_candle: '2026-09-14', candles: 3300, credits_spent: 0, attempts: 2, reason: 'credit_budget', last_attempt_at: new Date(NOW - 1000).toISOString() },
      { asset_key: 'market:contract:x', symbol: null, source: null, state: 'unavailable', priority: 101, candles: 0, credits_spent: 0, attempts: 1, reason: 'no_cmc_listing' },
    ],
  })
  const view = await readCandleCoverage(db, {}, NOW)
  assertEquals(view.view, 'candle_coverage')
  assertEquals((view.totals as Record<string, number>).assets, 3)
  assertEquals((view.totals as Record<string, number>).complete, 1)
  assertEquals((view.totals as Record<string, number>).candles, 8180)
  assertEquals((view.totals as Record<string, number>).creditsSpent, 50)
  assertEquals(view.oldestCandle, '2013-04-28')
  assertEquals(view.newestCandle, '2026-09-14')
})

Deno.test('a failed coverage read is a reason on an empty result, never a short list', async () => {
  const { db } = fakeDb({ market_asset_candle_backfill: [] }, { market_asset_candle_backfill: 'permission denied' })
  const view = await readCandleCoverage(db, {}, NOW)
  assertEquals(view.rows, [])
  assertEquals(view.reason, 'permission denied')
  assertEquals(view.asOf, null)
  assertEquals((view.totals as Record<string, number>).assets, 0)
})
