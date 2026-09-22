import { assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { planCmcRefresh, refreshOnDemandQuotes, ON_DEMAND_QUOTE_IDS, __resetOnDemandLaneForTests } from './cmc-refresh-planner.ts'

// ── Fakes ────────────────────────────────────────────────────────────────────

type Result = { data?: unknown; error?: unknown }

function fakeDb(tables: Record<string, Result> = {}) {
  const reads: { table: string; filters: Record<string, unknown> }[] = []
  return {
    reads,
    from(table: string) {
      const entry = { table, filters: {} as Record<string, unknown> }
      reads.push(entry)
      // deno-lint-ignore no-explicit-any
      const q: any = {}
      q.select = () => q
      q.eq = (column: string, value: unknown) => { entry.filters[column] = value; return q }
      q.gt = (column: string, value: unknown) => { entry.filters[`>${column}`] = value; return q }
      q.in = () => q
      q.order = () => q
      q.limit = (value: number) => { entry.filters.limit = value; return Promise.resolve(tables[table] ?? { data: [], error: null }) }
      q.maybeSingle = () => Promise.resolve(tables[table] ?? { data: null, error: null })
      return q
    },
  }
}

function fakeRequest(state: 'fresh' | 'unavailable' = 'fresh') {
  const calls: { name: string; input: Record<string, unknown>; ctx: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = ((name: string, input: Record<string, unknown>, ctx: Record<string, unknown>) => {
    calls.push({ name, input, ctx })
    return Promise.resolve({ payload: state === 'fresh' ? { data: [] } : null, state, reason: null, provenance: {} })
  }) as any
  return { calls, request }
}

const NOW = Date.parse('2026-09-15T12:00:00Z')
const demandRows = (ids: string[]) => ({ data: ids.map((id) => ({ provider_id: id, last_demanded_at: new Date(NOW - 60_000).toISOString() })), error: null })
const quoteCache = (ids: string) => ({ data: [{ request_params: { id: ids }, expires_at: new Date(NOW + 120_000).toISOString() }], error: null })

// ── The foreground demand lane (unchanged behaviour) ─────────────────────────

const cacheRow = (key: string, extra: Record<string, unknown> = {}) => ({
  cache_key: key, capability: 'quotes', request_params: {}, access_profile: 'basic',
  demanded_at: new Date(NOW - 60_000).toISOString(), demand_org_id: 'org-1', demand_user_id: 'user-1',
  expires_at: new Date(NOW - 1_000).toISOString(), refresh_until: null, fetched_at: new Date(NOW - 600_000).toISOString(),
  ...extra,
})

Deno.test('the foreground demand lane still takes at most eight due rows per pass', () => {
  const rows = Array.from({ length: 12 }, (_, i) => cacheRow(`key-${i}`))
  eq(planCmcRefresh(rows, 'basic', NOW).length, 8)
})

Deno.test('a row without a demand owner, or on another plan, is not refreshed', () => {
  eq(planCmcRefresh([cacheRow('a', { demand_user_id: null })], 'basic', NOW).length, 0)
  eq(planCmcRefresh([cacheRow('b', { demand_org_id: null })], 'basic', NOW).length, 0)
  eq(planCmcRefresh([cacheRow('c', { access_profile: 'startup' })], 'basic', NOW).length, 0)
  eq(planCmcRefresh([cacheRow('d', { demanded_at: new Date(NOW - 7_200_000).toISOString() })], 'basic', NOW).length, 0)
  eq(planCmcRefresh([cacheRow('e', { expires_at: new Date(NOW + 60_000).toISOString() })], 'basic', NOW).length, 0)
})

// ── The on-demand lane ───────────────────────────────────────────────────────

Deno.test('every in-use asset shares one batched quote call', async () => {
  __resetOnDemandLaneForTests()
  const db = fakeDb({ market_asset_demand: demandRows(['1027', '3408', '9900']), market_data_response_cache: quoteCache('1,1027,5426') })
  const { calls, request } = fakeRequest()
  eq(await refreshOnDemandQuotes(db, NOW, request), 'processed')

  eq(calls.length, 1)
  eq(calls[0].name, 'quotes')
  // 1027 is already covered by a live snapshot, so only the uncovered ids are asked for.
  eq(calls[0].input.id, '3408,9900')
  eq(calls[0].ctx.kind, 'job')
  eq(calls[0].ctx.maxCalls, 1)
  eq(calls[0].ctx.caller, 'intel-on-demand-refresh')
  eq(db.reads.map((r) => r.table), ['provider_schedule_policy', 'market_asset_demand', 'market_data_response_cache'])
  eq(db.reads[1].filters.provider, 'coinmarketcap')
  eq(db.reads[1].filters.limit, ON_DEMAND_QUOTE_IDS)
})

Deno.test('the lane runs at most once per policy cadence', async () => {
  __resetOnDemandLaneForTests()
  const tables = { market_asset_demand: demandRows(['3408']), market_data_response_cache: { data: [], error: null } }
  const { calls, request } = fakeRequest()
  eq(await refreshOnDemandQuotes(fakeDb(tables), NOW, request), 'processed')
  eq(await refreshOnDemandQuotes(fakeDb(tables), NOW + 299_000, request), 'idle')
  eq(calls.length, 1, 'a pass inside the cadence spends nothing')
  eq(await refreshOnDemandQuotes(fakeDb(tables), NOW + 300_000, request), 'processed')
  eq(calls.length, 2)

  // The cadence comes from provider_schedule_policy when the row is there.
  __resetOnDemandLaneForTests()
  const slow = { ...tables, provider_schedule_policy: { data: { cadence_seconds: 900, enabled: true }, error: null } }
  eq(await refreshOnDemandQuotes(fakeDb(slow), NOW, request), 'processed')
  eq(await refreshOnDemandQuotes(fakeDb(slow), NOW + 600_000, request), 'idle')
  eq(await refreshOnDemandQuotes(fakeDb(slow), NOW + 900_000, request), 'processed')
})

Deno.test('a disabled policy row stops the lane before it reads anything else', async () => {
  __resetOnDemandLaneForTests()
  const db = fakeDb({
    provider_schedule_policy: { data: { cadence_seconds: 300, enabled: false }, error: null },
    market_asset_demand: demandRows(['3408']),
  })
  const { calls, request } = fakeRequest()
  eq(await refreshOnDemandQuotes(db, NOW, request), 'idle')
  eq(calls.length, 0)
  eq(db.reads.map((r) => r.table), ['provider_schedule_policy'])
})

Deno.test('nothing in use, nothing already stale, and unreadable tables all cost nothing', async () => {
  __resetOnDemandLaneForTests()
  const { calls, request } = fakeRequest()
  eq(await refreshOnDemandQuotes(fakeDb({ market_asset_demand: { data: [], error: null } }), NOW, request), 'idle')

  __resetOnDemandLaneForTests()
  eq(await refreshOnDemandQuotes(fakeDb({
    market_asset_demand: demandRows(['3408']), market_data_response_cache: quoteCache('3408'),
  }), NOW, request), 'idle', 'a live snapshot already answers')

  __resetOnDemandLaneForTests()
  eq(await refreshOnDemandQuotes(fakeDb({ market_asset_demand: { data: null, error: { message: 'boom' } } }), NOW, request), 'error')

  __resetOnDemandLaneForTests()
  eq(await refreshOnDemandQuotes(fakeDb({
    market_asset_demand: demandRows(['3408']), market_data_response_cache: { data: null, error: { message: 'boom' } },
  }), NOW, request), 'error')

  eq(calls.length, 0)
})

Deno.test('the batch is deduplicated, numeric-only and capped at fifty ids', async () => {
  __resetOnDemandLaneForTests()
  const ids = ['3408', '3408', 'base:0xdead', '0', '', ...Array.from({ length: 60 }, (_, i) => String(i + 1000))]
  const db = fakeDb({ market_asset_demand: demandRows(ids), market_data_response_cache: { data: [], error: null } })
  const { calls, request } = fakeRequest()
  eq(await refreshOnDemandQuotes(db, NOW, request), 'processed')
  const sent = String(calls[0].input.id).split(',')
  eq(sent.length, ON_DEMAND_QUOTE_IDS)
  eq(new Set(sent).size, ON_DEMAND_QUOTE_IDS)
  eq(sent.every((id) => /^[1-9][0-9]*$/.test(id)), true)
})

Deno.test('a call that did not come back fresh is reported as idle, never as processed', async () => {
  __resetOnDemandLaneForTests()
  const { request } = fakeRequest('unavailable')
  eq(await refreshOnDemandQuotes(fakeDb({
    market_asset_demand: demandRows(['3408']), market_data_response_cache: { data: [], error: null },
  }), NOW, request), 'idle')
})
