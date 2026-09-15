// The candle history lane: where a year comes from, what it costs, what is
// stored, what is resumed, and what is refused.

import { assertEquals, assertStringIncludes } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  backfillAssetHistory, backfillCandidates, backfillOneAsset, candleRow, captureCandleBackfill,
  captureCandleDaily, ohlcvHistoryPages, CANDLE_CAPTURE_OPS, HISTORY_EPOCH_MS, OHLCV_MAX_PAGES,
} from './capture-candles.ts'
import { binanceDailyBar, binanceDailyHistory, BINANCE_EPOCH_MS } from './exchange-history.ts'
import { readCandleCoverage } from './capture-candles-read.ts'
import { estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'

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
const kline = (t: number, close: number, volume: number | null = 10) =>
  [t, close - 1, close + 1, close - 2, close, volume, t + DAY - 1, 0, 0, 0, 0, 0]

// ─── Binance history ──────────────────────────────────────────────────────────

Deno.test('a Binance daily row becomes a candle only when it is a completed UTC day', () => {
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100), NOW)!.t, YESTERDAY)
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100), NOW)!.closedAt, YESTERDAY + DAY - 1)
  // A day that has not closed is not a candle.
  assertEquals(binanceDailyBar(kline(YESTERDAY + DAY, 100), NOW), null)
  // A row whose open time is not on a UTC day boundary is not a daily candle.
  assertEquals(binanceDailyBar(kline(YESTERDAY + 3600_000, 100), NOW), null)
  // A zero volume is a real zero; an unreported one is null.
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100, 0), NOW)!.v, 0)
  assertEquals(binanceDailyBar(kline(YESTERDAY, 100, null), NOW)!.v, null)
  assertEquals(binanceDailyBar('not a row', NOW), null)
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

Deno.test('OHLCV pages walk backwards in thousand-day steps and cost about one credit per hundred days', () => {
  const from = Date.UTC(2013, 3, 28), to = Date.UTC(2026, 8, 15)
  const pages = ohlcvHistoryPages('1', from, to)
  assertEquals(pages.length, 5)
  const credits = pages.reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0)
  // Bitcoin since 2013 is about 4,900 daily points: about 50 credits, as documented.
  assertEquals(credits >= 45 && credits <= 60, true, `credits=${credits}`)
  // Each page names a single id, a daily period and a window its own count covers.
  for (const page of pages) {
    assertEquals(page.id, '1')
    assertEquals(page.interval, 'daily')
    assertEquals(page.time_period, 'daily')
    assertEquals(Date.parse(String(page.time_end)) - Date.parse(String(page.time_start)) <= (Number(page.count) - 1) * DAY, true)
  }
  // Nothing before the epoch is ever asked for.
  assertEquals(Date.parse(String(pages.at(-1)!.time_start)) >= HISTORY_EPOCH_MS - 1, true)
  assertEquals(ohlcvHistoryPages('1', to, to).length, 0)
  assertEquals(ohlcvHistoryPages('1', HISTORY_EPOCH_MS, to).length <= OHLCV_MAX_PAGES, true)
})

Deno.test('the whole top 100 stays under the five thousand credit budget', () => {
  // Worst case: every asset needs CoinMarketCap for its whole history and none
  // is listed on a free venue.
  const from = Date.UTC(2013, 0, 1), to = Date.UTC(2026, 8, 15)
  const perAsset = ohlcvHistoryPages('1', from, to).reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0)
  assertEquals(perAsset * 100 < 6000, true, `worst case ${perAsset * 100}`)
  // A realistic top 100 — a five-year median history — is well under the ceiling.
  const median = ohlcvHistoryPages('1', to - 5 * 365 * DAY, to).reduce((sum, page) => sum + estimateCmcCredits('ohlcv', { count: String(page.count) }), 0)
  assertEquals(median * 100 < 5000, true, `median case ${median * 100}`)
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
  const { db, writes } = fakeDb({ exchange_latest_tickers: [{ provider: 'binance', provider_symbol: 'XYZUSDT', normalized_symbol: 'XYZ', volume_quote_24h: 1 }] })
  let requests = 0
  const result = await backfillAssetHistory(db, { assetKey: 'market:coingecko:xyz', symbol: 'XYZ', cmcId: null }, {}, NOW, 400, {
    request: () => { requests += 1; return Promise.resolve(null) },
    exchange: () => Promise.resolve({ bars: [{ t: YESTERDAY, c: 1, closedAt: YESTERDAY + DAY - 1 }], pages: 1, reason: null, complete: true }),
  })
  assertEquals(requests, 0)
  assertEquals(result.credits, 0)
  assertEquals(result.complete, true)
  assertEquals(writes[0].onConflict, 'asset_key,provider,candle_interval,candle_time')
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
    market_asset_candle_backfill: [{ asset_key: KEY, provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', state: 'pending', priority: 1, candles: 0, credits_spent: 4990, attempts: 0 }],
  })
  let requests = 0
  const result = await captureCandleBackfill(db, ctxFor, new Date(NOW), 'startup', {
    request: () => { requests += 1; return Promise.resolve({ payload: ohlcvPayload('1', Date.UTC(2013, 3, 28), 5), provenance: {} }) },
    policy: [{ provider: 'coinmarketcap', feature: 'candle_history', cadence_seconds: 1200, enabled: true, max_credits: 5000 }],
  })
  assertEquals(result.creditCeiling, 5000)
  assertEquals(result.creditsSpentToDate, 4990)
  // Ten credits left is less than one thousand-day page, so nothing is bought.
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
