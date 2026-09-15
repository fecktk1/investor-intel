import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRegime, captureIndexConstituents, captureRwaUniverse, captureRankDaily, backfillRankHistory,
  captureLiquidations, captureAttention, captureAirdrops, backfillMondays, hourBucket, fiveMinuteBucket, utcDate,
  schedulePolicy, rwaAggregate,
} from './capture-jobs.ts'

// A week in the past keeps every provider timestamp behind the real clock, so
// `cmcObservedAt` never discards a fixture as a future observation.
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const minus = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

/** Minimal PostgREST-shaped fake: eq/gt/gte/lte/in filters, order, limit and
 * upsert. Every chain in the jobs ends in `.limit()` or `.upsert()`. */
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}) {
  const value = (row: any, key: string) => row?.[key]
  const compare = (a: any, b: any) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    from(table: string) {
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = value(row, key)
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gt') return compare(v, operand) > 0
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(value(a, ordering!.column), value(b, ordering!.column)) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
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
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const usd = (fields: Record<string, unknown>) => ({ quote: { USD: fields } })

Deno.test('schedule policy falls back to the designed cadence and honours a disabled row', () => {
  eq(schedulePolicy([], 'regime'), { enabled: true, cadenceSeconds: 3600, minPlan: null })
  eq(schedulePolicy([{ feature: 'structure', cadence_seconds: 900, enabled: true, min_plan: 'basic' }], 'structure').cadenceSeconds, 900)
  eq(schedulePolicy([{ feature: 'rwa', cadence_seconds: 3600, enabled: false }], 'rwa').enabled, false)
})

Deno.test('regime capture writes one row per hour, keeps the latest provider clock, and skips inside its cadence', async () => {
  const payloads: Record<string, any> = {
    fearGreed: { data: { value: 61, value_classification: 'Greed', update_time: minus(2_100_000) } },
    altcoinSeason: { data: { altcoin_index: 42, altcoin_marketcap: 1.2e12, timestamp: minus(1_500_000) } },
    global: {
      data: {
        btc_dominance: 54.2, eth_dominance: 12.1, active_cryptocurrencies: 9400, last_updated: minus(900_000),
        quote: { USD: { total_market_cap: 3.1e12, total_volume_24h: 1.2e11, stablecoin_market_cap: 2e11, defi_market_cap: 1e11, last_updated: minus(900_000) } },
      },
    },
  }
  const writes: Record<string, any[]> = {}
  let calls = 0
  const request = async (name: string) => { calls++; return { payload: payloads[name], state: 'fresh', reason: null } }
  const result = await captureRegime(fakeDb({}, writes), {}, NOW, { request, policy: [] })
  eq(result.rows, 1); eq(result.credits, 3); eq(calls, 3); eq(result.error, undefined)
  const row = writes.intel_regime_snapshots[0]
  eq(row.captured_at, hourBucket(NOW))
  eq(row.provider, 'coinmarketcap')
  eq(row.fear_greed_value, 61); eq(row.fear_greed_class, 'Greed'); eq(row.altcoin_season_index, 42)
  eq(row.btc_dominance, 54.2); eq(row.total_market_cap, 3.1e12); eq(row.defi_market_cap, 1e11)
  // The latest of the three provider clocks — the global payload here.
  eq(row.source_observed_at, minus(900_000))
  eq((row.raw as any).global.activeCryptocurrencies, 9400)

  const fresh = fakeDb({ intel_regime_snapshots: [{ captured_at: minus(300_000) }] }, {})
  const second = await captureRegime(fresh, {}, NOW, { request, policy: [{ feature: 'regime', cadence_seconds: 3600, enabled: true }] })
  eq(second.skipped, 'within_cadence'); eq(second.credits, 0); eq(calls, 3)
})

Deno.test('regime capture reports the provider reason instead of writing an empty row', async () => {
  const writes: Record<string, any[]> = {}
  const result = await captureRegime(fakeDb({}, writes), {}, NOW, { request: async () => ({ payload: null, reason: 'rate_limited' }), policy: [] })
  eq(result.rows, 0); eq(result.error, 'rate_limited'); eq(writes.intel_regime_snapshots, undefined)
})

Deno.test('a policy-disabled feature is skipped before any provider call', async () => {
  let calls = 0
  const deps = { request: async () => { calls++; return { payload: {} } }, policy: [{ feature: 'rwa', cadence_seconds: 3600, enabled: false }] }
  const result = await captureRwaUniverse(fakeDb(), {}, NOW, deps)
  eq(result.skipped, 'policy_disabled'); eq(result.credits, 0); eq(calls, 0)
})

Deno.test('index capture writes one row per index with a validated constituent array', async () => {
  const writes: Record<string, any[]> = {}
  const request = async (name: string) => ({
    payload: {
      data: {
        value: name === 'cmc100' ? 213.5 : 118.25, value_24h_percentage_change: name === 'cmc100' ? 1.4 : -0.6,
        constituents: [{ id: 1, name: 'Bitcoin', symbol: 'BTC', weight: 0.6 }, { id: 1027, name: 'Ethereum', symbol: 'ETH', weight: 0.2 }, { weight: 0.2 }],
      },
    },
  })
  const result = await captureIndexConstituents(fakeDb({}, writes), {}, NOW, { request, policy: [] })
  eq(result.rows, 2); eq(result.credits, 2)
  const rows = writes.intel_index_constituent_snapshots
  eq(rows.map((r: any) => r.index_code), ['cmc100', 'cmc20'])
  eq(rows[0].captured_at, hourBucket(NOW)); eq(rows[0].index_value, 213.5); eq(rows[1].value_24h_pct, -0.6)
  assert(Array.isArray(rows[0].constituents))
  // The unnamed entry carries neither id nor symbol and is dropped.
  eq(rows[0].constituents.length, 2)
  eq(rows[0].constituents[0], { id: 1, symbol: 'BTC', name: 'Bitcoin', weight: 0.6 })
})

Deno.test('RWA capture writes a row per asset type plus a derived all row', async () => {
  const pages: Record<string, any[]> = {
    stock: [
      { rwa_id: 10, symbol: 'NVDAon', name: 'NVIDIA', tokens: [{ issuer_id: 'issuer-a' }], ...usd({ tokenized_market_cap: 100, volume_24h: 5, percent_change_24h: 10 }) },
      { rwa_id: 11, symbol: 'TSLAon', name: 'Tesla', tokens: [{ issuer_id: 'issuer-b' }], ...usd({ tokenized_market_cap: 50, volume_24h: 2, percent_change_24h: -2 }) },
    ],
    commodity: [{ rwa_id: 1, symbol: 'PAXG', name: 'PAX Gold', tokens: [{ issuer_id: 'issuer-a' }], ...usd({ tokenized_market_cap: 25, volume_24h: 1, percent_change_24h: 4 }) }],
  }
  const writes: Record<string, any[]> = {}
  let calls = 0
  const request = async (_name: string, params: any) => { calls++; return { payload: { data: { rwa_assets: pages[params.asset_type] || [] } } } }
  const result = await captureRwaUniverse(fakeDb({}, writes), {}, NOW, { request, policy: [] })
  eq(calls, 6); eq(result.credits, 6); eq(result.rows, 7)
  const byType = Object.fromEntries(writes.intel_rwa_universe_snapshots.map((r: any) => [r.asset_type, r]))
  eq(byType.stock.asset_count, 2); eq(byType.stock.issuer_count, 2); eq(byType.stock.total_market_value_usd, 150)
  eq(byType.stock.volume_24h_usd, 7); eq(byType.stock.change_24h_pct, 6)   // value-weighted: (10*100 + -2*50) / 150
  eq(byType.stock.top_assets.length, 2); eq(byType.stock.top_assets[0].symbol, 'NVDAon')
  eq(byType.etf.asset_count, 0); eq(byType.etf.total_market_value_usd, null)
  eq(byType.all.asset_count, 3); eq(byType.all.issuer_count, 2)            // issuer-a is shared across types
  eq(byType.all.total_market_value_usd, 175); eq(byType.all.volume_24h_usd, 8)
  eq(Number(byType.all.change_24h_pct.toFixed(6)), Number(((6 * 150 + 4 * 25) / 175).toFixed(6)))
  eq(byType.all.captured_at, hourBucket(NOW))
})

Deno.test('RWA aggregate leaves an asset without a reported change out of the weighted average', () => {
  // cmcRows has already flattened `quote` to the USD object by this point.
  const summary = rwaAggregate([
    { rwa_id: 1, quote: { tokenized_market_cap: 100, percent_change_24h: 10 } },
    { rwa_id: 2, quote: { tokenized_market_cap: 100 } },
  ])
  eq(summary.value, 200); eq(summary.changePct, 10); eq(summary.issuers.size, 0)
})

Deno.test('daily rank capture reads the catalogue and spends no credits', async () => {
  const writes: Record<string, any[]> = {}
  const db = fakeDb({
    market_assets: [
      { source_provider: 'coinmarketcap', in_current_catalog: true, provider_id: '1', symbol: 'BTC', name: 'Bitcoin', market_cap_rank: 1, current_price: 64000, market_cap: 1.2e12, volume_24h: 3e10, circulating_supply: 19.8e6, total_supply: 19.8e6, max_supply: 21e6, change_24h_pct: 1.2, change_7d_pct: -3.4, as_of: minus(600_000) },
      { source_provider: 'coinmarketcap', in_current_catalog: true, provider_id: '1027', symbol: 'ETH', name: 'Ethereum', market_cap_rank: 2, current_price: 2500, market_cap: 3e11, volume_24h: 1e10, as_of: minus(600_000) },
      { source_provider: 'coingecko', in_current_catalog: true, provider_id: 'bitcoin', symbol: 'BTC', market_cap_rank: 1, as_of: minus(600_000) },
    ],
  }, writes)
  let calls = 0
  const result = await captureRankDaily(db, {}, NOW, { request: async () => { calls++; return { payload: {} } }, policy: [] })
  eq(calls, 0); eq(result.credits, 0); eq(result.rows, 2)
  const rows = writes.intel_rank_history
  eq(rows.map((r: any) => r.provider_id), ['1', '1027'])
  eq(rows[0].snapshot_date, utcDate(NOW)); eq(rows[0].source, 'listings_latest'); eq(rows[0].rank, 1)
  eq(rows[0].observed_at, minus(600_000)); eq(rows[0].num_market_pairs, null); eq(rows[0].max_supply, 21e6)
})

Deno.test('daily rank capture skips inside its cadence and reports an empty catalogue', async () => {
  const fresh = fakeDb({ intel_rank_history: [{ source: 'listings_latest', created_at: minus(3_600_000) }] })
  const skipped = await captureRankDaily(fresh, {}, NOW, { request: async () => ({ payload: {} }), policy: [] })
  eq(skipped.skipped, 'within_cadence')
  const empty = await captureRankDaily(fakeDb(), {}, NOW, { request: async () => ({ payload: {} }), policy: [] })
  eq(empty.skipped, 'catalogue_empty'); eq(empty.rows, 0)
})

Deno.test('rank backfill skips weeks already present, honours maxWeeksPerRun and reports the remainder', async () => {
  const mondays = backfillMondays(NOW, 4)
  eq(mondays.length, 4)
  for (const date of mondays) eq(new Date(`${date}T00:00:00Z`).getUTCDay(), 1)
  const writes: Record<string, any[]> = {}
  const db = fakeDb({
    intel_rank_history: [{ provider: 'coinmarketcap', provider_id: '1', snapshot_date: mondays[0], source: 'listings_historical', created_at: minus(5 * 86_400_000) }],
  }, writes)
  const requested: string[] = []
  const request = async (name: string, params: any) => {
    requested.push(`${name}:${params.date}`)
    return {
      payload: {
        data: [
          { id: 1, symbol: 'BTC', name: 'Bitcoin', cmc_rank: 1, num_market_pairs: 11000, circulating_supply: 19e6, quote: { USD: { price: 61000, market_cap: 1.1e12, volume_24h: 2e10, percent_change_24h: 0.4, percent_change_7d: 2.2, last_updated: `${params.date}T00:00:00.000Z` } } },
          { id: 1027, symbol: 'ETH', cmc_rank: 2, quote: { USD: { price: 2400, market_cap: 2.9e11 } } },
        ],
      },
    }
  }
  const result = await backfillRankHistory(db, {}, { weeks: 4, limit: 250, maxWeeksPerRun: 2, now: NOW }, { request, policy: [] })
  eq(requested, [`listingsHistorical:${mondays[1]}`, `listingsHistorical:${mondays[2]}`])
  eq(result.weeksCaptured, 2); eq(result.remaining, 1); eq(result.credits, 6); eq(result.rows, 4)
  const written = writes.intel_rank_history
  eq(written[0].snapshot_date, mondays[1]); eq(written[0].source, 'listings_historical')
  eq(written[0].rank, 1); eq(written[0].num_market_pairs, 11000); eq(written[0].price, 61000)
  eq(written[0].observed_at, `${mondays[1]}T00:00:00.000Z`); eq(written[1].num_market_pairs, null)
})

Deno.test('rank backfill reports nothing remaining once every week is present', async () => {
  const mondays = backfillMondays(NOW, 3)
  const db = fakeDb({ intel_rank_history: mondays.map((date) => ({ provider: 'coinmarketcap', provider_id: '1', snapshot_date: date, source: 'listings_historical', created_at: minus(5 * 86_400_000) })) })
  let calls = 0
  const result = await backfillRankHistory(db, {}, { weeks: 3, now: NOW }, { request: async () => { calls++; return { payload: {} } }, policy: [] })
  eq(calls, 0); eq(result.credits, 0); eq(result.remaining, 0); eq(result.rows, 0)
})

Deno.test('liquidation capture buckets to five minutes and collapses a repeated identity', async () => {
  const writes: Record<string, any[]> = {}
  const request = async () => ({
    payload: {
      data: {
        cryptocurrencies: [
          { id: 1, symbol: 'BTC', ...usd({ total_liquidations_1h: 1_200_000, total_liquidations_4h: 5e6, total_liquidations_24h: 3.4e7, long_liquidations_1h: 900_000, short_liquidations_1h: 300_000 }) },
          { id: 1027, symbol: 'ETH', ...usd({ total_liquidations_1h: 400_000 }) },
          { id: 1027, symbol: 'ETH', ...usd({ total_liquidations_1h: 450_000 }) },
        ],
      },
    },
  })
  const at = new Date(NOW.getTime() + 187_000)   // 3 minutes 7 seconds past the hour
  const result = await captureLiquidations(fakeDb({}, writes), {}, at, { request, policy: [] })
  eq(result.credits, 1); eq(result.rows, 2)
  const rows = writes.intel_liquidation_snapshots
  eq(rows[0].captured_at, fiveMinuteBucket(at)); eq(rows[0].captured_at, hourBucket(NOW))
  eq(rows[0].provider_id, '1'); eq(rows[0].liq_1h, 1_200_000); eq(rows[0].long_1h, 900_000)
  eq(rows[0].long_24h, null); eq(rows[0].universe, 'covered_derivatives')
  eq(Object.keys(rows[0].raw).sort(), ['liq_1h', 'liq_24h', 'liq_4h', 'long_1h', 'short_1h'])
  eq(rows[1].liq_1h, 450_000)   // the later row of a repeated identity wins
})

Deno.test('attention capture is skipped below Startup and ranks each list by position above it', async () => {
  let calls = 0
  const deps = {
    request: async (name: string, params: any) => {
      calls++
      return { payload: { data: [{ id: 1, symbol: 'BTC', ...usd({ price: 64000, volume_24h: 3e10, percent_change_24h: params.sort_dir === 'asc' ? -9 : 9 }) }, { id: 1027, symbol: 'ETH', ...usd({ price: 2500 }) }] } }
    },
    policy: [],
  }
  const blocked = await captureAttention(fakeDb(), {}, NOW, 'basic', deps)
  eq(blocked.skipped, 'plan_below_startup'); eq(blocked.credits, 0); eq(calls, 0)

  const writes: Record<string, any[]> = {}
  const result = await captureAttention(fakeDb({}, writes), {}, NOW, 'startup', deps)
  eq(calls, 4); eq(result.credits, 4); eq(result.rows, 8)
  const rows = writes.intel_attention_snapshots
  eq([...new Set(rows.map((r: any) => r.list))], ['trending', 'most_visited', 'gainers', 'losers'])
  eq(rows[0], { list: 'trending', time_period: '', captured_at: hourBucket(NOW), provider_id: '1', symbol: 'BTC', rank: 1, price: 64000, volume_24h: 3e10, change_24h_pct: 9 })
  eq(rows[1].rank, 2)
  eq(rows.find((r: any) => r.list === 'losers').change_24h_pct, -9)
})

Deno.test('airdrop capture is skipped below Builder and never rewrites first_seen_at above it', async () => {
  let calls = 0
  const statuses: string[] = []
  const deps = {
    request: async (_name: string, params: any) => {
      calls++; statuses.push(String(params.status))
      return { payload: { data: [{ id: 'airdrop-1', project_name: 'Example', coin: { id: 9, symbol: 'EX', slug: 'example' }, status: params.status, start_date: minus(86_400_000), end_date: null, total_prize: 50000, winner_count: 2000, link: 'https://example.test/airdrop' }] } }
    },
    policy: [],
  }
  const blocked = await captureAirdrops(fakeDb(), {}, NOW, 'basic', deps)
  eq(blocked.skipped, 'plan_below_builder'); eq(calls, 0)

  const writes: Record<string, any[]> = {}
  const result = await captureAirdrops(fakeDb({}, writes), {}, NOW, 'builder', deps)
  eq(statuses, ['ONGOING', 'UPCOMING']); eq(result.credits, 2)
  // Both statuses report the same airdrop id; one row survives and it carries no
  // first_seen_at, so the stored discovery time is preserved by the upsert.
  eq(result.rows, 1)
  const row = writes.intel_airdrop_snapshots[0]
  eq('first_seen_at' in row, false)
  eq(row.last_seen_at, NOW.toISOString()); eq(row.airdrop_id, 'airdrop-1'); eq(row.provider_id, '9')
  eq(row.status, 'UPCOMING'); eq(row.total_prize, 50000); eq(row.winner_count, 2000)

  const fresh = fakeDb({ intel_airdrop_snapshots: [{ last_seen_at: minus(3_600_000) }] })
  eq((await captureAirdrops(fresh, {}, NOW, 'builder', deps)).skipped, 'within_cadence')
})
