import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readRwaWrapperHistory, historyParams, closedCalendar, closedSpans,
  RWA_WRAPPER_HISTORY_VIEWS, RWA_WRAPPER_HISTORY_CAPTURE_VIEWS, HISTORY_RANGES, HISTORY_POINT_CAP, HISTORY_TOKEN_CAP,
} from './capture-rwa-wrapper-history-read.ts'
import { ASSET_TABLE, TOKEN_TABLE } from './capture-rwa-wrappers.ts'
import { BACKFILL_TABLE, BACKFILL_METHOD } from './capture-rwa-wrapper-backfill.ts'

const NOW = Date.parse('2026-09-22T12:00:00.000Z')
const DAY = 86_400_000
const hour = (h: number) => new Date(Date.parse('2026-09-20T14:00:00.000Z') + h * 3_600_000).toISOString()

// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const reads: { table: string; filters: any[] }[] = []
  return {
    reads,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      reads.push({ table, filters })
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => op === 'eq' ? String(row?.[key]) === String(operand) : String(row?.[key] ?? '') >= String(operand))
        }
        if (ordering) rows.sort((a, b) => String(a?.[ordering!.column]).localeCompare(String(b?.[ordering!.column])) * (ordering!.ascending ? 1 : -1))
        return { data: rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, o: any = {}) => { ordering = { column, ascending: o?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
      }
      return q
    },
  }
}

const assetRow = (h: number, over: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', rwa_id: '1', captured_at: hour(h), symbol: 'GOLD', name: 'Gold', asset_type: 'commodity',
  anchor_kind: 'liquid_wrapper_median', anchor_price: 4000, anchor_reason: 'no_nav_feed_mapped', anchor_members: 2,
  dispersion_bps: 40, weighted_spread_bps: 12, cheapest_crypto_id: '20245', cheapest_premium_bps: -20, wrapper_count: 2, ...over,
})
const tokenRow = (h: number, cryptoId: string, premium: number) => ({
  rwa_id: '1', crypto_id: cryptoId, captured_at: hour(h), symbol: cryptoId === '5176' ? 'XAUT' : 'CGO', name: null,
  wrapper_state: 'liquid', premium_bps: premium, accrual_gap_bps: null, in_anchor: true, volume_24h: 1e6,
})
const backfillRow = (day: string, cryptoId: string, premium: number) => ({
  provider: 'coinmarketcap', rwa_id: '1', crypto_id: cryptoId, day, method: BACKFILL_METHOD, symbol: cryptoId === '5176' ? 'XAUT' : 'CGO', name: null,
  wrapper_state: 'liquid', premium_bps: premium, accrual_gap_bps: null, in_anchor: true, volume_24h: 1e6,
  anchor_kind: 'liquid_wrapper_median', anchor_price: 3990, anchor_reason: 'no_nav_feed_mapped', anchor_members: 2,
  asset_dispersion_bps: 30, asset_weighted_spread_bps: 9, wrapper_set_captured_at: hour(1),
})

const tables = () => ({
  [ASSET_TABLE]: [assetRow(1), assetRow(7), assetRow(13)],
  [TOKEN_TABLE]: [1, 7, 13].flatMap((h) => [tokenRow(h, '5176', 10), tokenRow(h, '20245', -20)]),
  [BACKFILL_TABLE]: ['2026-09-17', '2026-09-18', '2026-09-19'].flatMap((d) => [backfillRow(d, '5176', 5), backfillRow(d, '20245', -15)]),
})

Deno.test('params: rwaId must be an integer id and days one of 30/90/180/365', () => {
  eq(HISTORY_RANGES, [30, 90, 180, 365])
  eq(historyParams({ rwaId: '1', days: 30 }), { rwaId: '1', days: 30, reason: null })
  eq(historyParams({ rwaId: 7, days: '365' }), { rwaId: '7', days: 365, reason: null })
  eq(historyParams({}), { rwaId: null, days: 90, reason: null })
  eq(historyParams({ rwaId: '1; drop' }).reason, 'invalid_rwa_id')
  eq(historyParams({ rwaId: '0' }).reason, 'invalid_rwa_id')
  eq(historyParams({ rwaId: '1', days: 45 }).reason, 'invalid_days')
  eq(historyParams({ rwaId: '1', days: 'all' }).reason, 'invalid_days')
})

Deno.test('an invalid parameter reads nothing but the selector and says why', async () => {
  const db = fakeDb(tables())
  const result = await readRwaWrapperHistory(db, { rwaId: '1', days: 7 }, NOW)
  eq(result.reason, 'invalid_days')
  eq(result.wrappers, [])
  eq(db.reads.map((r) => r.table), [ASSET_TABLE])
})

Deno.test('no asset named: the selector from the newest hour, ranked by dispersion', async () => {
  const t = tables()
  t[ASSET_TABLE].push(assetRow(13, { rwa_id: '5', symbol: 'SILVER', name: 'Silver', dispersion_bps: 90 }))
  const result = await readRwaWrapperHistory(fakeDb(t), {}, NOW)
  eq(result.reason, 'no_asset_selected')
  // deno-lint-ignore no-explicit-any
  eq((result.assets as any[]).map((a) => a.rwaId), ['5', '1'])
})

Deno.test('one asset: reconstructed days before the live capture, live captures after, every point labelled', async () => {
  const result = await readRwaWrapperHistory(fakeDb(tables()), { rwaId: '1', days: 30 }, NOW)
  eq(result.reason, null)
  // deno-lint-ignore no-explicit-any
  const wrappers = result.wrappers as any[]
  eq(wrappers.map((w) => w.cryptoId), ['20245', '5176'])
  eq(wrappers[0].cheapestLiquid, true)
  eq([wrappers[0].reconstructed, wrappers[0].captured], [3, 3])
  // deno-lint-ignore no-explicit-any
  const sources = wrappers[0].points.map((p: any) => p.source)
  eq(sources, ['ohlcv_reconstructed', 'ohlcv_reconstructed', 'ohlcv_reconstructed', 'capture', 'capture', 'capture'])
  // deno-lint-ignore no-explicit-any
  assert(wrappers[0].points.every((p: any, i: number, all: any[]) => i === 0 || p.t > all[i - 1].t))
  // deno-lint-ignore no-explicit-any
  const boundary = result.boundary as any
  eq(boundary.liveFrom, hour(1))
  eq(boundary.reconstructedFrom, '2026-09-17T00:00:00.000Z')
  eq(boundary.reconstructedDays, 3)
  // deno-lint-ignore no-explicit-any
  const anchor = result.anchor as any[]
  eq(anchor.length, 6)
  eq([anchor[0].source, anchor[0].dispersionBps, anchor.at(-1).source, anchor.at(-1).weightedSpreadBps], ['ohlcv_reconstructed', 30, 'capture', 12])
  eq(result.asOf, hour(13))
  eq(result.truncated, false)
  // Commodity: weekends only, and it says COMEX holidays are not modelled.
  // deno-lint-ignore no-explicit-any
  const calendar = result.calendar as any
  eq([calendar.kind, calendar.note], ['weekends_only', 'comex_holidays_not_modelled'])
  // deno-lint-ignore no-explicit-any
  assert(calendar.days.every((d: any) => d.kind === 'weekend'))
})

Deno.test('a reconstructed row on or after the live capture day is dropped, not drawn', async () => {
  const t = tables()
  t[BACKFILL_TABLE].push(backfillRow('2026-09-20', '5176', 99))
  const result = await readRwaWrapperHistory(fakeDb(t), { rwaId: '1', days: 30 }, NOW)
  // deno-lint-ignore no-explicit-any
  eq((result.boundary as any).reconstructedDropped, 1)
  // deno-lint-ignore no-explicit-any
  assert(!(result.wrappers as any[]).some((w) => w.points.some((p: any) => p.premiumBps === 99)))
})

Deno.test('a missing backfill table degrades to the live history and names the reason', async () => {
  const result = await readRwaWrapperHistory(fakeDb(tables(), { [BACKFILL_TABLE]: 'relation does not exist' }), { rwaId: '1', days: 30 }, NOW)
  eq(result.reason, 'relation does not exist')
  // deno-lint-ignore no-explicit-any
  eq((result.wrappers as any[])[0].reconstructed, 0)
  // deno-lint-ignore no-explicit-any
  eq((result.wrappers as any[])[0].captured, 3)
})

Deno.test('the read is bounded, filtered to one asset and the window, and downsamples long series', async () => {
  const many = Array.from({ length: 600 }, (_, i) => ({ ...tokenRow(0, '5176', i), captured_at: new Date(NOW - (600 - i) * 3_600_000).toISOString() }))
  const db = fakeDb({ ...tables(), [TOKEN_TABLE]: many })
  const result = await readRwaWrapperHistory(db, { rwaId: '1', days: 30 }, NOW)
  eq(result.downsampled, true)
  // deno-lint-ignore no-explicit-any
  eq((result.wrappers as any[]).find((w) => w.cryptoId === '5176').points.length, HISTORY_POINT_CAP)
  const tokenFilters = db.reads.find((r) => r.table === TOKEN_TABLE)!.filters
  eq(tokenFilters[0], ['rwa_id', 'eq', '1'])
  eq(tokenFilters[1][0], 'captured_at')
  eq(HISTORY_TOKEN_CAP, 8000)
})

Deno.test('stock and etf shade weekends and NYSE holidays; other types shade nothing', () => {
  const from = Date.parse('2026-09-01T00:00:00Z'), to = Date.parse('2026-09-10T00:00:00Z')
  const stock = closedCalendar('stock', from, to)
  eq(stock.kind, 'nyse')
  assert(stock.days.some((d) => d.date === '2026-09-07' && d.kind === 'holiday'))
  eq(closedCalendar('government_security', from, to).days, [])
  // The Labor Day weekend is one band: Saturday through Monday.
  const spans = closedSpans(stock.days)
  const labour = spans.find((s) => s.from === Date.parse('2026-09-05T00:00:00Z'))!
  eq([labour.to, labour.kind], [Date.parse('2026-09-08T00:00:00Z') - 1, 'holiday'])
})

Deno.test('the integration map exposes exactly rwa_wrapper_history under both names', () => {
  eq(Object.keys(RWA_WRAPPER_HISTORY_VIEWS), ['rwa_wrapper_history'])
  eq(RWA_WRAPPER_HISTORY_CAPTURE_VIEWS, RWA_WRAPPER_HISTORY_VIEWS)
  void DAY
})
