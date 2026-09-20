import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  readCaptureView, readRegime, readRegimeAt, readRankMap, readRwaUniverse, readIndexConstituents, readLiquidations, readAttention, readBreadth,
  samplePoints, rwaChange24h, CAPTURE_VIEWS,
} from './capture-read.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 10)

/** Minimal PostgREST-shaped fake; every read chain ends in `.limit()`. */
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: any, b: any) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    from(table: string) {
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gt') return compare(v, operand) > 0
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: rows.slice(0, max), error: null }
      }
      const q: any = {
        select: () => q,
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        gt: (k: string, v: any) => { filters.push([k, 'gt', v]); return q },
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        lte: (k: string, v: any) => { filters.push([k, 'lte', v]); return q },
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
      }
      return q
    },
  }
}

Deno.test('every view returns an empty, bounded shape for empty tables and never an error', async () => {
  const db = fakeDb()
  for (const view of CAPTURE_VIEWS) {
    const result = await readCaptureView(db, view, { date: daysAgo(3), providerIds: ['1'] }, NOW)
    eq(result.view, view)
    eq(result.asOf, null)
    eq(result.coverage.count, 0)
    eq(result.coverage.from, null)
    const series = (result.series ?? result.rows ?? result.top ?? result.captures) as unknown[]
    eq(Array.isArray(series) ? series.length : -1, 0)
  }
  const unknown = await readCaptureView(db, 'nope', {}, NOW)
  eq(unknown.reason, 'unsupported_view'); eq(unknown.asOf, null)
})

Deno.test('regime view is chronological, bounded by its range and downsampled to 400 points', async () => {
  const rows = Array.from({ length: 900 }, (_, i) => ({
    captured_at: hoursAgo(899 - i), fear_greed_value: 40 + (i % 20), fear_greed_class: 'Neutral',
    altcoin_season_index: 30, btc_dominance: 54, eth_dominance: 12,
    total_market_cap: 3e12 + i, total_volume_24h: 1e11, stablecoin_market_cap: 2e11, defi_market_cap: 1e11,
    source_observed_at: hoursAgo(899 - i),
  }))
  const db = fakeDb({ intel_regime_snapshots: rows })
  const result = await readRegime(db, { range: '7d' }, NOW)
  eq(result.range, '7d')
  // 7 days of hourly rows: 169 inside the window (inclusive of the boundary row).
  eq(result.coverage.count, 169)
  eq((result.series as any[]).length, 169)
  eq((result.series as any[])[0].capturedAt, hoursAgo(168))
  eq(result.asOf, hoursAgo(0))
  eq((result.series as any[]).at(-1).capturedAt, hoursAgo(0))

  const wide = await readRegime(db, { range: '90d' }, NOW)
  eq(wide.coverage.count, 900)
  eq((wide.series as any[]).length, 400)
  eq((wide.series as any[]).at(-1).capturedAt, hoursAgo(0))
  eq(wide.asOf, hoursAgo(0))

  // An unknown range falls back to 30 days rather than reading everything.
  eq((await readRegime(db, { range: 'forever' }, NOW)).range, '30d')
})

Deno.test('regime view reports a failed read as a reason on an empty series', async () => {
  const result = await readRegime(fakeDb({}, { intel_regime_snapshots: 'permission denied' }), { range: '30d' }, NOW)
  eq((result.series as any[]).length, 0); eq(result.asOf, null); eq(result.reason, 'permission denied')
})

Deno.test('regime_at picks the closest capture and the historical top ten for that date', async () => {
  const day = daysAgo(3)
  const db = fakeDb({
    intel_regime_snapshots: [
      { captured_at: `${day}T00:00:00.000Z`, fear_greed_value: 30 },
      { captured_at: `${day}T21:00:00.000Z`, fear_greed_value: 55 },
      { captured_at: `${daysAgo(2)}T04:00:00.000Z`, fear_greed_value: 61 },
    ],
    intel_rank_history: [
      { snapshot_date: day, source: 'listings_historical', provider_id: '1', symbol: 'BTC', rank: 1, price: 61000 },
      { snapshot_date: day, source: 'listings_historical', provider_id: '1027', symbol: 'ETH', rank: 2, price: 2400 },
      { snapshot_date: daysAgo(2), source: 'listings_historical', provider_id: '1', symbol: 'BTC', rank: 1 },
    ],
  })
  const result = await readRegimeAt(db, { date: day }, NOW)
  eq(result.date, day)
  eq((result.regime as any).capturedAt, `${day}T00:00:00.000Z`)   // closest to midnight of the requested day
  eq((result.top as any[]).map((r: any) => r.symbol), ['BTC', 'ETH'])
  eq((result.top as any[])[0].source, 'listings_historical')
  eq(result.asOf, `${day}T00:00:00.000Z`)
  eq(result.coverage.count, 3)
  eq((await readRegimeAt(db, { date: 'not-a-date' }, NOW)).reason, 'invalid_date')
})

Deno.test('regime_at falls back to the daily row when a date has no historical listing', async () => {
  const day = daysAgo(1)
  const db = fakeDb({
    intel_regime_snapshots: [{ captured_at: `${day}T12:00:00.000Z`, fear_greed_value: 50 }],
    intel_rank_history: [{ snapshot_date: day, source: 'listings_latest', provider_id: '1', symbol: 'BTC', rank: 1 }],
  })
  const result = await readRegimeAt(db, { date: day }, NOW)
  eq((result.top as any[]).length, 1)
  eq((result.top as any[])[0].source, 'listings_latest')
})

Deno.test('rank_map returns weekly series for the current top N with entries and exits', async () => {
  // The newest daily row is deliberately the Tuesday after a Monday, so the
  // weekly dates and the latest date never collide in the fixture.
  const anchor = new Date(`${daysAgo(1)}T00:00:00Z`)
  anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7))
  const monday = (week: number) => new Date(anchor.getTime() - week * 7 * 86_400_000).toISOString().slice(0, 10)
  const latest = new Date(anchor.getTime() + 86_400_000).toISOString().slice(0, 10)
  const row = (date: string, id: string, symbol: string, rank: number, source = 'listings_historical') => ({ snapshot_date: date, provider_id: id, symbol, rank, source })
  const db = fakeDb({
    intel_rank_history: [
      row(latest, '1', 'BTC', 1, 'listings_latest'), row(latest, '1027', 'ETH', 2, 'listings_latest'), row(latest, '5426', 'SOL', 3, 'listings_latest'),
      row(monday(0), '1', 'BTC', 1), row(monday(0), '1027', 'ETH', 2), row(monday(0), '52', 'XRP', 3),
      row(monday(1), '1', 'BTC', 1), row(monday(1), '1027', 'ETH', 3),
    ],
  })
  const result = await readRankMap(db, { top: 3, weeks: 4 }, NOW)
  eq(result.asOf, latest)
  const series = result.series as any[]
  eq(series.map((s) => s.providerId), ['1', '1027', '5426'])
  eq(series[0].symbol, 'BTC')
  // Chronological points across the weekly dates that exist.
  eq(series[1].points.map((p: any) => p.rank), [3, 2, 2])
  eq((result.entries as any[]).map((e: any) => e.providerId), ['5426'])
  eq((result.exits as any[]).map((e: any) => e.providerId), ['52'])
  eq(result.previousDate, monday(0))
  assert((result.dates as string[]).includes(monday(3)))
})

Deno.test('rank_map leaves entries and exits empty when only one week has been captured', async () => {
  const latest = daysAgo(1)
  const db = fakeDb({ intel_rank_history: [{ snapshot_date: latest, provider_id: '1', symbol: 'BTC', rank: 1 }] })
  const result = await readRankMap(db, { top: 5 }, NOW)
  eq((result.series as any[]).length, 1)
  eq((result.entries as any[]).length, 0); eq((result.exits as any[]).length, 0)
  eq(result.previousDate, null)
})

Deno.test('rwa_universe returns the latest row per type with a per-type series', async () => {
  const rows: any[] = []
  for (let hour = 0; hour < 48; hour++) {
    for (const assetType of ['stock', 'commodity', 'all']) {
      rows.push({
        asset_type: assetType, captured_at: hoursAgo(hour),
        asset_count: 10, issuer_count: 3, total_market_value_usd: 1000 + hour, volume_24h_usd: 20, change_24h_pct: 1.5,
        top_assets: [{ rwa_id: 1, symbol: 'PAXG', value: 500 }],
      })
    }
  }
  const result = await readRwaUniverse(fakeDb({ intel_rwa_universe_snapshots: rows }), { days: 30 }, NOW)
  eq(Object.keys(result.latest as any).sort(), ['all', 'commodity', 'stock'])
  eq((result.latest as any).stock.totalMarketValueUsd, 1000)
  eq((result.latest as any).stock.topAssets.length, 1)
  const series = result.series as any[]
  eq(series.length, 3)
  eq(series[0].points.length, 48)
  eq(series[0].points[0].capturedAt, hoursAgo(47))
  eq(result.asOf, hoursAgo(0))
  eq(result.coverage.count, 144)
  // A stored provider figure is still preferred, and the payload names it.
  eq((result.latest as any).stock.change24hSource, 'provider')
  eq((result.latest as any).stock.change24hPct, 1.5)
})

Deno.test('the 24h change of tokenised value is derived from our own snapshots and labelled as ours', async () => {
  // The real production numbers for 2026-09-20 14:00 UTC against 2026-09-19
  // 14:00 UTC, with the provider column null exactly as it is in the table.
  const rows: any[] = []
  const values: Record<string, number[]> = {
    all: [6_047_920_375.241231, 6_038_272_304.216032],
    stock: [1_335_235_928.3587286, 1_331_821_155.2348022],
    // A type the provider lists nothing for: no value, so no change either.
    currency: [],
  }
  for (const [assetType, [previous, current]] of Object.entries(values)) {
    for (let hour = 0; hour < 25; hour++) {
      rows.push({
        asset_type: assetType, captured_at: hoursAgo(hour),
        asset_count: assetType === 'currency' ? 0 : 4812,
        assets_scanned: assetType === 'currency' ? 0 : 250,
        assets_with_tokens: assetType === 'currency' ? 0 : 193,
        issuer_count: 0,
        total_market_value_usd: assetType === 'currency' ? null : hour === 0 ? current : hour >= 24 ? previous : current,
        volume_24h_usd: assetType === 'currency' ? null : 12_345,
        change_24h_pct: null,
        top_assets: [],
      })
    }
  }
  const result = await readRwaUniverse(fakeDb({ intel_rwa_universe_snapshots: rows }), { days: 30 }, NOW)
  const latest = result.latest as any

  eq(latest.all.change24hSource, 'our_snapshots')
  eq(latest.all.change24hFromAt, hoursAgo(24))
  eq(latest.all.change24hToAt, hoursAgo(0))
  eq(Number(latest.all.change24hPct.toFixed(4)), -0.1595)
  eq(Number(latest.stock.change24hPct.toFixed(4)), -0.2557)

  // The coverage columns travel through so the surface can say how wide the
  // token count was counted.
  eq(latest.stock.assetCount, 4812)
  eq(latest.stock.assetsScanned, 250)
  eq(latest.stock.assetsWithTokens, 193)

  // A type with nothing captured gets a reason, never a fabricated zero.
  eq(latest.currency.change24hPct, null)
  eq(latest.currency.change24hReason, 'no_value_captured')
  eq(latest.currency.assetCount, 0)
})

Deno.test('a 24h change with no comparable earlier capture says so instead of showing zero', () => {
  const at = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString()

  // Nothing near 24 hours back: the nearest point is 6 hours old.
  eq(rwaChange24h([
    { capturedAt: at(6), totalMarketValueUsd: 100 },
    { capturedAt: at(0), totalMarketValueUsd: 110 },
  ]).reason, 'no_comparable_capture_24h_earlier')

  // Inside the three hour tolerance a catch-up gap still produces a figure, and
  // the instant actually used is reported rather than assumed to be 24h.
  const tolerant = rwaChange24h([
    { capturedAt: at(26), totalMarketValueUsd: 100 },
    { capturedAt: at(0), totalMarketValueUsd: 110 },
  ])
  eq(tolerant.changePct, 10)
  eq(tolerant.fromAt, at(26))

  // A zero base has no percentage change, and saying so beats dividing by nothing.
  eq(rwaChange24h([
    { capturedAt: at(24), totalMarketValueUsd: 0 },
    { capturedAt: at(0), totalMarketValueUsd: 5 },
  ]).reason, 'previous_value_zero')

  // A single capture is not a change.
  eq(rwaChange24h([{ capturedAt: at(0), totalMarketValueUsd: 5 }]).reason, 'no_comparable_capture_24h_earlier')
  eq(rwaChange24h([]).reason, 'no_value_captured')

  // The nearest of several candidates wins, so a dense series does not pick the
  // edge of the tolerance window.
  eq(rwaChange24h([
    { capturedAt: at(26), totalMarketValueUsd: 50 },
    { capturedAt: at(24), totalMarketValueUsd: 100 },
    { capturedAt: at(22), totalMarketValueUsd: 200 },
    { capturedAt: at(0), totalMarketValueUsd: 110 },
  ]).changePct, 10)
})

Deno.test('index_constituents returns both latest rows with their constituents and a value series', async () => {
  const rows: any[] = []
  for (let hour = 0; hour < 24; hour++) {
    for (const code of ['cmc100', 'cmc20']) {
      rows.push({ index_code: code, captured_at: hoursAgo(hour), index_value: 200 + hour, value_24h_pct: -0.5, constituents: [{ id: 1, symbol: 'BTC', weight: 0.6 }] })
    }
  }
  const result = await readIndexConstituents(fakeDb({ intel_index_constituent_snapshots: rows }), {}, NOW)
  eq(Object.keys(result.latest as any).sort(), ['cmc100', 'cmc20'])
  eq((result.latest as any).cmc100.value, 200)
  eq((result.latest as any).cmc20.constituents.length, 1)
  const series = result.series as any[]
  eq(series.length, 2)
  eq(series[0].points.length, 24)
  eq(result.asOf, hoursAgo(0))
})

Deno.test('liquidations returns per-asset 24-hour rows and an hourly total series', async () => {
  const rows: any[] = []
  for (let minutes = 0; minutes < 60 * 26; minutes += 5) {
    const capturedAt = new Date(NOW.getTime() - minutes * 60_000).toISOString()
    rows.push({ provider_id: '1', captured_at: capturedAt, symbol: 'BTC', liq_1h: 1000, liq_4h: 4000, liq_24h: 24000, long_1h: 700, short_1h: 300 })
    rows.push({ provider_id: '1027', captured_at: capturedAt, symbol: 'ETH', liq_1h: 500 })
  }
  const result = await readLiquidations(fakeDb({ intel_liquidation_snapshots: rows }), { providerIds: ['1', '1027'] }, NOW)
  eq((result.providerIds as string[]), ['1', '1027'])
  const assets = result.rows as any[]
  eq(assets.map((a) => a.providerId).sort(), ['1', '1027'])
  eq(assets[0].symbol, 'BTC')
  // 24 hours of 5-minute samples, inclusive of the boundary sample.
  eq(assets[0].points.length, 289)
  eq(assets[0].points[0].capturedAt < assets[0].points.at(-1).capturedAt, true)
  eq(assets[0].points.at(-1).liq1h, 1000)
  const series = result.series as any[]
  // One sample per asset per hour, summed across the two assets.
  eq(series.every((point: any) => point.total === 1500 && point.assets === 2), true)
  eq(series.length, 27)
  eq(result.asOf, NOW.toISOString())

  const none = await readLiquidations(fakeDb(), { providerIds: [] }, NOW)
  eq(none.reason, 'no_asset_selected'); eq((none.rows as any[]).length, 0); eq(none.asOf, null)
})

Deno.test('liquidations caps the requested asset list and the total series inputs', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => String(i + 1))
  const result = await readLiquidations(fakeDb({ intel_liquidation_snapshots: [] }), { providerIds: ids }, NOW)
  eq((result.providerIds as string[]).length, 10)
  eq((result.totalProviderIds as string[]).length, 3)
})

Deno.test('attention returns one asset\'s list membership per capture and the capture stamps of the window', async () => {
  const rows: any[] = []
  // Six hourly captures; the asset is trending in the newest three and a loser in the oldest, absent otherwise.
  for (let h = 0; h < 6; h++) {
    const capturedAt = hoursAgo(h)
    for (const list of ['trending', 'most_visited', 'gainers', 'losers']) rows.push({ list, time_period: '', captured_at: capturedAt, provider_id: '99', rank: 1 })
    if (h < 3) rows.push({ list: 'trending', time_period: '', captured_at: capturedAt, provider_id: '1027', rank: 4 + h })
    if (h === 5) rows.push({ list: 'losers', time_period: '', captured_at: capturedAt, provider_id: '1027', rank: 20 })
  }
  rows.push({ list: 'trending', time_period: '', captured_at: hoursAgo(40), provider_id: '1027', rank: 1 }) // outside the 24 h window
  const result = await readAttention(fakeDb({ intel_attention_snapshots: rows }), { providerId: 1027 }, NOW)
  eq(result.providerId, '1027'); eq(result.hours, 24)
  const lists = result.lists as Record<string, any[]>
  eq(lists.trending.map((p) => p.rank), [6, 5, 4])
  eq(lists.trending[0].capturedAt < lists.trending.at(-1).capturedAt, true)
  eq(lists.losers.length, 1); eq(lists.gainers.length, 0); eq(lists.most_visited.length, 0)
  eq((result.captures as string[]).length, 6)
  eq(result.asOf, NOW.toISOString())
  eq(result.coverage.count, 4)

  const none = await readAttention(fakeDb(), {}, NOW)
  eq(none.reason, 'no_asset_selected'); eq((none.captures as string[]).length, 0); eq(none.asOf, null)
  const week = await readAttention(fakeDb(), { providerId: '1', hours: 900 }, NOW)
  eq(week.hours, 168)
  const broken = await readAttention(fakeDb({}, { intel_attention_snapshots: 'denied' }), { providerId: '1' }, NOW)
  eq(broken.reason, 'denied')
})

Deno.test('samplePoints keeps the first and last observation', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => i)
  const sampled = samplePoints(rows, 400)
  eq(sampled.length, 400); eq(sampled[0], 0); eq(sampled.at(-1), 999)
  eq(samplePoints([1, 2, 3], 400), [1, 2, 3])
})

Deno.test('breadth reads the newest daily listing capture once and states both sides over one population', async () => {
  const row = (date: string, id: string, cap: number | null, change: number | null, rank: number) => ({
    provider: 'coinmarketcap', source: 'listings_latest', snapshot_date: date, provider_id: id, symbol: `S${id}`, rank,
    market_cap: cap, change_24h_pct: change, observed_at: `${date}T00:0${rank % 10}:00.000Z`,
  })
  const today = daysAgo(0), yesterday = daysAgo(1)
  const db = fakeDb({ intel_rank_history: [
    row(yesterday, '1', 900, -50, 1),
    row(today, '1', 900, 1, 1), row(today, '2', 100, 11, 2), row(today, '3', null, 40, 3), row(today, '4', 50, null, 4),
    { ...row(today, '5', 10, 99, 5), source: 'listings_historical' },
  ] })
  const r = await readBreadth(db, {}, NOW) as Record<string, any>
  eq(r.snapshotDate, today)
  eq(r.included, 2)
  eq(r.excludedNoMarketCap, 1)
  eq(r.excludedNoReturn, 1)
  eq(r.total, 4, 'the historical backfill row is a different source and is not read')
  eq(Math.round(r.capWeightedReturnPct * 1e9) / 1e9, 2)
  eq(r.medianReturnPct, 6)
  eq(Math.round(r.spreadPts * 1e9) / 1e9, -4)
  eq(r.coverage.count, 4)
  eq(r.asOf, `${today}T00:04:00.000Z`)
  const empty = await readCaptureView(fakeDb(), 'breadth', {}, NOW) as Record<string, any>
  eq(empty.spreadPts, null)
  eq(empty.snapshotDate, null)
})
