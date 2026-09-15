import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readExchangeReserves, readVenueShare, sampleDays, VENUE_CAPTURE_VIEWS, VENUE_CAPTURE_VIEW_NAMES,
} from './capture-venues-read.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const day = (back: number) => new Date(NOW.getTime() - back * 86_400_000).toISOString().slice(0, 10)

/** Minimal PostgREST-shaped fake; every read chain ends in `.limit()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  // deno-lint-ignore no-explicit-any
  const compare = (a: any, b: any) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  const reads: { table: string; limit: number }[] = []
  return {
    reads,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
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
        lte: (k: string, v: any) => { filters.push([k, 'lte', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => { reads.push({ table, limit: max }); return Promise.resolve(run(max)) },
      }
      return q
    },
  }
}

const reserve = (exchangeId: number, date: string, providerId: number, symbol: string, usd: number) => ({
  exchange_id: exchangeId, snapshot_date: date, provider_id: String(providerId), platform_symbol: 'ETH',
  exchange_slug: `venue-${exchangeId}`, symbol, balance: usd / 2, usd_value: usd, wallet_count: 3,
})

/** Fifteen assets, 1500 down to 100 — twelve named plus an "other" bucket. */
const fifteen = (exchangeId: number, date: string, scale = 1) =>
  Array.from({ length: 15 }, (_, i) => reserve(exchangeId, date, 100 + i, `T${i}`, (15 - i) * 100 * scale))

const venue = (kind: string, exchangeId: number, date: string, volume: number | null, openInterest: number | null, pairs: number) => ({
  kind, exchange_id: exchangeId, snapshot_date: date, exchange_slug: `venue-${exchangeId}`,
  volume_24h: volume, open_interest: openInterest, num_market_pairs: pairs, observed_at: `${date}T00:05:00.000Z`,
})

// ─── shared shape ─────────────────────────────────────────────────────────────

Deno.test('both views return an empty, bounded shape for empty tables and never an error', async () => {
  const db = fakeDb()
  for (const view of VENUE_CAPTURE_VIEW_NAMES) {
    const result = await VENUE_CAPTURE_VIEWS[view](db, { days: 30, exchangeId: 1, kind: 'spot' }, NOW.getTime())
    eq(result.view, view)
    eq(result.asOf, null)
    eq(result.coverage, { from: null, to: null, count: 0 })
    eq((result.series as unknown[]).length, 0)
    eq((result.exchanges as unknown[]).length, 0)
    eq(result.reason, null)
  }
  eq(VENUE_CAPTURE_VIEW_NAMES, ['exchange_reserves', 'venue_share'])
})

Deno.test('sampled days always cover the newest day and stay inside the window', () => {
  eq(sampleDays(day(0), 7, 14), [day(0), day(1), day(2), day(3), day(4), day(5), day(6)])
  const month = sampleDays(day(0), 30, 20)
  eq(month.length, 20); eq(month[0], day(0)); eq(month.at(-1), day(29))
  const year = sampleDays(day(0), 365, 20)
  eq(year.length, 20); eq(year[0], day(0)); eq(year.at(-1), day(364))
  eq(sampleDays('not-a-date', 30, 20), [])
})

// ─── exchange_reserves ────────────────────────────────────────────────────────

Deno.test('exchange reserves report the latest composition as twelve assets plus other', async () => {
  const db = fakeDb({ intel_exchange_reserve_snapshots: fifteen(1, day(0)) })
  const result = await readExchangeReserves(db, { days: 7 }, NOW)
  eq(result.asOf, day(0)); eq(result.days, 7); eq(result.priorDate, day(7))
  const exchanges = result.exchanges as Record<string, unknown>[]
  eq(exchanges.length, 1)
  eq(exchanges[0].exchangeId, 1); eq(exchanges[0].exchangeSlug, 'venue-1')
  eq(exchanges[0].totalUsdValue, 12000); eq(exchanges[0].assetCount, 15); eq(exchanges[0].otherAssetCount, 3)
  const composition = exchanges[0].composition as Record<string, unknown>[]
  eq(composition.length, 13)
  eq(composition[0].symbol, 'T0'); eq(composition[0].usdValue, 1500); eq(composition[0].walletCount, 3)
  eq(composition[0].sharePct, 12.5)
  eq(composition[0].platformSymbol, 'ETH')
  const other = composition.at(-1)!
  eq(other.symbol, 'other'); eq(other.providerId, null); eq(other.usdValue, 600); eq(other.balance, null)
  // Nothing was captured `days` ago, so every drift is null rather than a jump from zero.
  eq(exchanges[0].priorAvailable, false); eq(exchanges[0].priorTotalUsdValue, null); eq(exchanges[0].driftUsdValue, null)
  eq(composition[0].priorUsdValue, null); eq(composition[0].driftUsdValue, null); eq(composition[0].driftPct, null)
  eq(other.driftUsdValue, null)
})

Deno.test('exchange reserve drift compares the same asset with the day `days` ago and never interpolates', async () => {
  const rows = [
    ...fifteen(1, day(0)), ...fifteen(1, day(7), 0.5),           // full history: every drift is +100%
    ...fifteen(2, day(0)),                                       // no earlier day at all
    reserve(3, day(0), 900, 'AAA', 400), reserve(3, day(0), 901, 'BBB', 300), reserve(3, day(0), 902, 'CCC', 200),
    reserve(3, day(7), 900, 'AAA', 200), reserve(3, day(7), 901, 'BBB', 100), // CCC not held then
  ]
  const result = await readExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: rows }), { days: 7 }, NOW)
  const byId = new Map((result.exchanges as Record<string, unknown>[]).map((e) => [e.exchangeId, e]))

  const one = byId.get(1)!
  eq(one.priorAvailable, true); eq(one.priorTotalUsdValue, 6000)
  eq(one.driftUsdValue, 6000); eq(one.driftPct, 100)
  const oneComposition = one.composition as Record<string, unknown>[]
  eq(oneComposition[0].priorUsdValue, 750); eq(oneComposition[0].driftUsdValue, 750); eq(oneComposition[0].driftPct, 100)
  // "other" is exact: the earlier total less the earlier value of the named twelve.
  eq(oneComposition.at(-1)!.priorUsdValue, 300); eq(oneComposition.at(-1)!.driftUsdValue, 300)

  const two = byId.get(2)!
  eq(two.priorAvailable, false)
  eq((two.composition as Record<string, unknown>[]).every((c) => c.driftUsdValue === null), true)

  const three = byId.get(3)!
  const assets = new Map((three.composition as Record<string, unknown>[]).map((c) => [c.symbol, c]))
  eq(assets.get('AAA')!.driftUsdValue, 200); eq(assets.get('BBB')!.driftUsdValue, 200)
  // The earlier day exists but does not list CCC; an absence is not a zero balance.
  eq(assets.get('CCC')!.priorUsdValue, null); eq(assets.get('CCC')!.driftUsdValue, null); eq(assets.get('CCC')!.driftPct, null)
  eq(three.priorTotalUsdValue, 300)
})

Deno.test('exchange reserves return a daily total series with a null point for an uncaptured day', async () => {
  const rows = [...fifteen(1, day(0)), ...fifteen(1, day(3)), ...fifteen(2, day(3))]
  const result = await readExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: rows }), { days: 7 }, NOW)
  const series = result.series as Record<string, unknown>[]
  eq(series.length, 8)                                   // seven sampled days plus the drift anchor
  eq(series.map((p) => p.date), [day(7), day(6), day(5), day(4), day(3), day(2), day(1), day(0)])
  const byDate = new Map(series.map((p) => [p.date, p]))
  eq(byDate.get(day(0))!.total, 12000); eq(byDate.get(day(0))!.exchanges, 1)
  eq(byDate.get(day(3))!.total, 24000); eq(byDate.get(day(3))!.exchanges, 2)
  eq((byDate.get(day(3))!.byExchange as Record<string, unknown>[]).length, 2)
  eq(byDate.get(day(1))!.total, null); eq(byDate.get(day(1))!.exchanges, 0)
  eq(result.coverage.count, 45)
  eq(result.coverage.from, day(3)); eq(result.coverage.to, day(0)); eq(result.coverage.truncated, false)
})

Deno.test('exchange reserves honour the exchange filter, the day allow-list and a failed read', async () => {
  const rows = [...fifteen(1, day(0)), ...fifteen(2, day(0))]
  const filtered = await readExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: rows }), { days: 7, exchangeId: '2' }, NOW)
  eq((filtered.exchanges as Record<string, unknown>[]).map((e) => e.exchangeId), [2])
  eq(filtered.coverage.count, 15)

  // 7 / 30 / 90 only; anything else falls back to 30 days rather than erroring.
  const defaulted = await readExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: rows }), { days: 5 }, NOW)
  eq(defaulted.days, 30); eq(defaulted.priorDate, day(30))
  eq(((await readExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: rows }), { days: 90 }, NOW)).days), 90)

  const broken = await readExchangeReserves(fakeDb({}, { intel_exchange_reserve_snapshots: 'permission denied' }), { days: 7 }, NOW)
  eq(broken.reason, 'permission denied'); eq(broken.asOf, null); eq(broken.coverage.count, 0)
})

Deno.test('exchange reserve reads stay bounded per day', async () => {
  const db = fakeDb({ intel_exchange_reserve_snapshots: fifteen(1, day(0)) })
  await readExchangeReserves(db, { days: 90 }, NOW)
  // One latest-date probe plus at most fifteen day reads, each capped.
  assert(db.reads.length <= 16, `expected a bounded number of reads, got ${db.reads.length}`)
  assert(db.reads.every((read) => read.limit <= 2600))
})

// ─── venue_share ──────────────────────────────────────────────────────────────

const spotDay = (date: string, exchanges = 12) =>
  Array.from({ length: exchanges }, (_, i) => venue('spot', i + 1, date, (exchanges - i) * 1e9, null, 100 + i))

const venueDerivatives = (date: string) =>
  Array.from({ length: 4 }, (_, i) => venue('derivatives', i + 1, date, (4 - i) * 1e9, (4 - i) * 1e8, 50 + i))

Deno.test('venue share reports the daily share of the top ten venues plus other', async () => {
  const dates = sampleDays(day(0), 30, 20)
  const rows = [...spotDay(dates[0]), ...spotDay(dates[5]), ...venueDerivatives(dates[0])]
  const result = await readVenueShare(fakeDb({ intel_venue_share_snapshots: rows }), { days: 30, kind: 'spot' }, NOW)
  eq(result.view, 'venue_share'); eq(result.kind, 'spot'); eq(result.days, 30); eq(result.asOf, dates[0])
  // 12 venues: 12e9 down to 1e9, 78e9 in total.
  eq(result.totalVolume24h, 78e9)
  const exchanges = result.exchanges as Record<string, unknown>[]
  eq(exchanges.length, 10)
  eq(exchanges[0].exchangeId, 1); eq(exchanges[0].volume24h, 12e9); eq(exchanges[0].exchangeSlug, 'venue-1')
  eq(Math.round(Number(exchanges[0].sharePct) * 100) / 100, 15.38)
  eq(exchanges[0].numMarketPairs, 100)
  // Spot rows carry no open interest, so the OI series is empty rather than zero.
  eq(exchanges[0].openInterest, null); eq(exchanges[0].oiSharePct, null)
  eq((result.oiSeries as unknown[]).length, 0)

  const series = result.series as Record<string, unknown>[]
  eq(series.length, 2)
  eq(series.map((p) => p.date), [dates[5], dates[0]])
  const latest = series[1]
  eq(latest.total, 78e9); eq(latest.venues, 12)
  const shares = latest.shares as Record<string, unknown>[]
  eq(shares.length, 10)
  const other = latest.other as Record<string, unknown>
  eq(other.venues, 2); eq(other.value, 3e9)
  const summed = shares.map((s) => Number(s.sharePct)).reduce((a, b) => a + b, 0) + Number(other.sharePct)
  eq(Math.round(summed), 100)

  const pairs = result.pairs as Record<string, unknown>[]
  eq(pairs.length, 10)
  eq((pairs[0].points as Record<string, unknown>[]).length, 20)
  eq((pairs[0].points as Record<string, unknown>[]).at(-1), { date: dates[0], numMarketPairs: 100 })
  // A day with no capture for that venue is a null point, never carried forward.
  eq((pairs[0].points as Record<string, unknown>[])[1].numMarketPairs, null)
  eq(result.coverage.from, dates[5]); eq(result.coverage.to, dates[0])
  eq(result.coverage.count, 24); eq(result.coverage.truncated, false)
})

Deno.test('venue share reports the open-interest share where it was captured', async () => {
  const dates = sampleDays(day(0), 90, 20)
  const rows = [...spotDay(dates[0]), ...venueDerivatives(dates[0]), ...venueDerivatives(dates[3])]
  const result = await readVenueShare(fakeDb({ intel_venue_share_snapshots: rows }), { days: 90, kind: 'derivatives' }, NOW)
  eq(result.days, 90); eq(result.kind, 'derivatives'); eq(result.asOf, dates[0])
  eq(result.totalOpenInterest, 1e9)
  const exchanges = result.exchanges as Record<string, unknown>[]
  eq(exchanges.length, 4)
  eq(exchanges[0].openInterest, 4e8); eq(exchanges[0].oiSharePct, 40)
  const oiSeries = result.oiSeries as Record<string, unknown>[]
  eq(oiSeries.length, 2)
  eq(oiSeries.at(-1)!.total, 1e9)
  eq((oiSeries.at(-1)!.shares as Record<string, unknown>[])[0].sharePct, 40)
  // Every derivatives venue is inside the top ten, so "other" is empty.
  eq((oiSeries.at(-1)!.other as Record<string, unknown>).venues, 0)
  eq((oiSeries.at(-1)!.other as Record<string, unknown>).value, null)
  eq((result.series as unknown[]).length, 2)
})

Deno.test('venue share defaults an unknown kind and window, and reports a failed read', async () => {
  const dates = sampleDays(day(0), 30, 20)
  const db = fakeDb({ intel_venue_share_snapshots: spotDay(dates[0]) })
  const defaulted = await readVenueShare(db, { days: 7, kind: 'futures' }, NOW)
  eq(defaulted.kind, 'spot'); eq(defaulted.days, 30)
  eq((await readVenueShare(db, { days: 365 }, NOW)).days, 365)

  const broken = await readVenueShare(fakeDb({}, { intel_venue_share_snapshots: 'permission denied' }), { days: 30 }, NOW)
  eq(broken.reason, 'permission denied'); eq(broken.asOf, null); eq(broken.coverage.count, 0)
  eq((broken.series as unknown[]).length, 0)
})

Deno.test('venue share reads stay bounded per day', async () => {
  const dates = sampleDays(day(0), 365, 20)
  const db = fakeDb({ intel_venue_share_snapshots: spotDay(dates[0]) })
  await readVenueShare(db, { days: 365 }, NOW)
  assert(db.reads.length <= 21, `expected a bounded number of reads, got ${db.reads.length}`)
  assert(db.reads.every((read) => read.limit <= 220))
})
