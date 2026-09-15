import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureCategories, captureCategoryMembers, captureNetworkStats, blockchainStatRows,
  CATEGORY_CAPTURE_OPS, CATEGORY_LIST_LIMIT, MEMBER_CATEGORIES,
} from './capture-categories.ts'

// A week in the past keeps every provider timestamp behind the real clock.
const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const HOUR = NOW.toISOString()
const DAY = NOW.toISOString().slice(0, 10)
const minus = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

/** Minimal PostgREST-shaped fake: eq/gt/gte/lte/in filters, order, limit and
 * upsert. Every chain in the jobs ends in `.limit()` or `.upsert()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            // deno-lint-ignore no-explicit-any
            if (op === 'in') return (operand as any[]).some((o) => String(o) === String(v))
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
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
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })
/** Records every provider call so a lane's call ceiling is checked, not assumed. */
// deno-lint-ignore no-explicit-any
function fakeRequest(handler: (name: string, params: Record<string, unknown>) => any) {
  const calls: { name: string; params: Record<string, unknown> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, unknown> = {}, _ctx?: any) => {
    calls.push({ name, params })
    return Promise.resolve(handler(name, params))
  }
  return { request, calls }
}

const categoryPayload = (count: number) => ({
  data: Array.from({ length: count }, (_, i) => ({
    id: `cat-${i}`, name: `Category ${i}`, title: `Title ${i}`, description: 'ignored',
    num_tokens: 10 + i, avg_price_change: -1.5 + i, market_cap: (count - i) * 1e9,
    market_cap_change: 2.5, volume: (count - i) * 1e7, volume_change: -3.25, last_updated: minus(600_000),
  })),
})

// ─── categories ───────────────────────────────────────────────────────────────

Deno.test('categories capture writes one hourly row per category and prices the page from the registry', async () => {
  const { request, calls } = fakeRequest(() => ({ payload: categoryPayload(3) }))
  const writes: Record<string, unknown[]> = {}
  const result = await captureCategories(fakeDb({}, writes), ctxFor, NOW, { request, policy: [] })
  eq(result.job, 'categories')
  eq(result.rows, 3)
  eq(result.credits, 3, 'one categories page is 1 + ceil(250/200) credits')
  eq(result.capturedAt, HOUR)
  eq(calls.length, 1, 'the whole board is one call')
  eq(calls[0].params.limit, CATEGORY_LIST_LIMIT)
  const rows = writes.intel_category_snapshots as Record<string, unknown>[]
  eq(rows.length, 3)
  eq(rows[0].provider, 'coinmarketcap')
  eq(rows[0].category_id, 'cat-0')
  eq(rows[0].captured_at, HOUR)
  eq(rows[0].num_tokens, 10)
  eq(rows[0].market_cap, 3e9)
  eq(rows[0].volume_change, -3.25)
  eq(rows[0].observed_at, minus(600_000))
  assert(!('description' in rows[0]), 'the description is not stored')
})

Deno.test('categories capture collapses a repeated category and drops one with no id', async () => {
  const { request } = fakeRequest(() => ({
    data: undefined,
    payload: { data: [{ id: 'dup', name: 'First', market_cap: 1 }, { id: 'dup', name: 'Second', market_cap: 2 }, { name: 'No id' }] },
  }))
  const writes: Record<string, unknown[]> = {}
  const result = await captureCategories(fakeDb({}, writes), ctxFor, NOW, { request, policy: [] })
  eq(result.rows, 1)
  eq((writes.intel_category_snapshots as Record<string, unknown>[])[0].name, 'Second', 'the last occurrence wins')
})

Deno.test('categories capture honours its cadence, a disabled policy row and an exhausted call budget', async () => {
  const { request, calls } = fakeRequest(() => ({ payload: categoryPayload(2) }))
  const db = fakeDb({ intel_category_snapshots: [{ captured_at: minus(600_000) }] })
  const fresh = await captureCategories(db, ctxFor, NOW, { request, policy: [] })
  eq(fresh.skipped, 'within_cadence')
  eq(fresh.credits, 0)
  eq(fresh.newestAt, minus(600_000))

  const disabled = await captureCategories(fakeDb(), ctxFor, NOW, { request, policy: [{ feature: 'categories', cadence_seconds: 3600, enabled: false }] })
  eq(disabled.skipped, 'policy_disabled')

  const broke = await captureCategories(fakeDb(), () => ({ maxCalls: 0 }), NOW, { request, policy: [] })
  eq(broke.skipped, 'call_budget')
  eq(calls.length, 0, 'a skipped run never reaches the provider')
})

Deno.test('categories capture reports an unavailable provider and a throwing transport without throwing', async () => {
  const down = await captureCategories(fakeDb(), ctxFor, NOW,
    { request: () => Promise.resolve({ payload: null, reason: 'plan_denied' }), policy: [] })
  eq(down.rows, 0)
  eq(down.error, 'plan_denied')
  eq(down.credits, 3, 'the call was attempted, so its credit ceiling is reported')

  const exploded = await captureCategories(fakeDb(), ctxFor, NOW, { request: () => { throw new Error('boom') }, policy: [] })
  eq(exploded.rows, 0)
  eq(exploded.error, 'boom')

  const empty = await captureCategories(fakeDb(), ctxFor, NOW, { request: () => Promise.resolve({ payload: { data: [] } }), policy: [] })
  eq(empty.skipped, 'no_reported_categories')
})

// ─── category_members ─────────────────────────────────────────────────────────

const boardRows = (count: number) => Array.from({ length: count }, (_, i) => ({
  provider: 'coinmarketcap', category_id: `cat-${i}`, captured_at: HOUR, name: `Category ${i}`, market_cap: (count - i) * 1e9,
}))

const memberPayload = (ids: number[]) => ({ payload: { data: { id: 'cat', coins: ids.map((id) => ({ id, symbol: `S${id}`, name: `Name ${id}`, cmc_rank: id })) } } })

Deno.test('category members capture reads the largest categories of the newest board, one credit each', async () => {
  const { request, calls } = fakeRequest(() => memberPayload([1, 1027]))
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ intel_category_snapshots: [...boardRows(3), { provider: 'coinmarketcap', category_id: 'stale', captured_at: minus(86_400_000), market_cap: 9e12 }] }, writes)
  const result = await captureCategoryMembers(db, ctxFor, NOW, { request, policy: [{ feature: 'category_members', cadence_seconds: 86400, enabled: true }] })
  eq(result.job, 'category_members')
  eq(result.rows, 6)
  eq(result.credits, 3, 'one credit per category call')
  eq(result.snapshotDate, DAY)
  eq(result.sourceCapturedAt, HOUR)
  eq(result.categories, 3)
  eq(result.pendingCategories, 0)
  eq(calls.map((c) => c.params.id), ['cat-0', 'cat-1', 'cat-2'], 'largest first, and never the stale capture')
  eq(calls.every((c) => c.params.limit === 200), true)
  const rows = writes.intel_category_members as Record<string, unknown>[]
  eq(rows[0], { provider: 'coinmarketcap', category_id: 'cat-0', snapshot_date: DAY, provider_id: '1', symbol: 'S1', cmc_rank: 1 })
})

Deno.test('category members capture stops at the context call budget and reports the rest as pending', async () => {
  const { request, calls } = fakeRequest(() => memberPayload([1]))
  const writes: Record<string, unknown[]> = {}
  const db = fakeDb({ intel_category_snapshots: boardRows(5) }, writes)
  const result = await captureCategoryMembers(db, (_n, _m) => ({ maxCalls: 2 }), NOW, { request, policy: [] })
  eq(calls.length, 2, 'the budget is a hard ceiling on provider calls')
  eq(result.credits, 2)
  eq(result.categories, 2)
  eq(result.pendingCategories, 3)
  eq(result.partial, 'call_budget')
  eq(result.rows, 2)
})

Deno.test('category members capture never exceeds its own ceiling even with a larger budget', async () => {
  const { request, calls } = fakeRequest(() => memberPayload([1]))
  const db = fakeDb({ intel_category_snapshots: boardRows(60) })
  const result = await captureCategoryMembers(db, () => ({ maxCalls: 500 }), NOW, { request, policy: [] })
  // The board read itself stops at the lane's ceiling, so a 60-category board is
  // 40 calls and nothing is left pending: the tail was never a candidate.
  eq(calls.length, MEMBER_CATEGORIES)
  eq(result.credits, MEMBER_CATEGORIES)
  eq(result.pendingCategories, 0)
  eq(result.categories, MEMBER_CATEGORIES)
})

Deno.test('category members capture skips an empty board, honours its cadence and records a partial failure', async () => {
  const { request } = fakeRequest(() => memberPayload([1]))
  eq((await captureCategoryMembers(fakeDb(), ctxFor, NOW, { request, policy: [] })).skipped, 'no_category_snapshot')

  const fresh = await captureCategoryMembers(
    fakeDb({ intel_category_snapshots: boardRows(2), intel_category_members: [{ created_at: minus(3_600_000) }] }),
    ctxFor, NOW, { request, policy: [{ feature: 'category_members', cadence_seconds: 86400, enabled: true }] })
  eq(fresh.skipped, 'within_cadence')

  // With no policy row the lane keeps its designed daily cadence instead of
  // falling back to the hourly default, which would be 40 credits an hour.
  eq((await captureCategoryMembers(
    fakeDb({ intel_category_snapshots: boardRows(2), intel_category_members: [{ created_at: minus(3_600_000) }] }),
    ctxFor, NOW, { request, policy: [] })).skipped, 'within_cadence')

  let call = 0
  const partial = await captureCategoryMembers(fakeDb({ intel_category_snapshots: boardRows(2) }), ctxFor, NOW,
    { request: () => Promise.resolve(++call === 1 ? memberPayload([1]) : { payload: null, reason: 'rate_limited' }), policy: [] })
  eq(partial.rows, 1)
  eq(partial.partial, 'rate_limited')
  eq(partial.credits, 2, 'a failed call still consumed its budget')
})

Deno.test('category members capture reports a read failure and a throwing transport without throwing', async () => {
  const { request } = fakeRequest(() => memberPayload([1]))
  const broken = await captureCategoryMembers(fakeDb({}, {}, { intel_category_snapshots: 'read_denied' }), ctxFor, NOW, { request, policy: [] })
  eq(broken.rows, 0)
  eq(broken.error, 'read_denied')

  const exploded = await captureCategoryMembers(fakeDb({ intel_category_snapshots: boardRows(1) }), ctxFor, NOW,
    { request: () => { throw new Error('transport_down') }, policy: [] })
  eq(exploded.rows, 0)
  eq(exploded.error, 'transport_down', 'a transport that throws is reported, never re-thrown')
})

// ─── network_stats ────────────────────────────────────────────────────────────

const statsPayload = {
  data: {
    '1': { id: 1, symbol: 'BTC', hashrate_24h: 6.1e20, difficulty: 8.9e13, tps_24h: 6.5, pending_transactions: 1200, total_blocks: 860000, total_transactions: 1.1e9, block_reward_static: 3.125 },
    '1027': { id: 1027, symbol: 'ETH', hashrate_24h: null, difficulty: 0, tps_24h: 14.2, total_blocks: 2.05e7, total_transactions: 2.4e9 },
  },
}

Deno.test('network stats capture is skipped below Growth and never spends a call to find out', async () => {
  const { request, calls } = fakeRequest(() => ({ payload: statsPayload }))
  for (const plan of ['basic', 'builder', 'startup']) {
    const result = await captureNetworkStats(fakeDb(), ctxFor, NOW, plan, { request, policy: [] })
    eq(result.skipped, 'plan_below_growth')
    eq(result.credits, 0)
  }
  eq(calls.length, 0)
})

Deno.test('network stats capture records one hourly row per chain on Growth', async () => {
  const { request, calls } = fakeRequest(() => ({ payload: statsPayload }))
  const writes: Record<string, unknown[]> = {}
  const result = await captureNetworkStats(fakeDb({}, writes), ctxFor, NOW, 'growth', { request, policy: [] })
  eq(result.rows, 2)
  eq(result.credits, 1, 'the whole batch is one credit')
  eq(result.capturedAt, HOUR)
  eq(calls[0].params.id, '1,1027,2')
  const rows = writes.intel_network_stats_snapshots as Record<string, unknown>[]
  eq(rows[0].provider_id, '1')
  eq(rows[0].symbol, 'BTC')
  eq(rows[0].hashrate_24h, 6.1e20)
  eq(rows[1].hashrate_24h, null, 'a metric the chain does not report stays null')
  eq('hashrate_24h' in (rows[1].raw as Record<string, unknown>), false, 'and never appears as an invented zero in raw')
  eq((rows[1].raw as Record<string, unknown>).tps_24h, 14.2)
})

Deno.test('network stats capture honours its cadence and survives a provider failure', async () => {
  const { request } = fakeRequest(() => ({ payload: statsPayload }))
  const fresh = await captureNetworkStats(fakeDb({ intel_network_stats_snapshots: [{ captured_at: minus(600_000) }] }), ctxFor, NOW, 'growth', { request, policy: [] })
  eq(fresh.skipped, 'within_cadence')

  const down = await captureNetworkStats(fakeDb(), ctxFor, NOW, 'enterprise', { request: () => Promise.resolve({ payload: null, reason: 'http_403' }), policy: [] })
  eq(down.error, 'http_403')
  eq(down.rows, 0)

  const empty = await captureNetworkStats(fakeDb(), ctxFor, NOW, 'growth', { request: () => Promise.resolve({ payload: { data: {} } }), policy: [] })
  eq(empty.skipped, 'no_reported_chains')
})

Deno.test('blockchain statistics rows survive both the id-keyed map and a plain list', () => {
  eq(blockchainStatRows(statsPayload).map((r) => r.symbol), ['BTC', 'ETH'])
  eq(blockchainStatRows({ data: [{ id: 2, symbol: 'LTC' }] }).map((r) => r.symbol), ['LTC'])
  eq(blockchainStatRows({ data: null }), [])
  eq(blockchainStatRows(null), [])
})

Deno.test('the capture ops surface exposes exactly the three lanes', async () => {
  eq(Object.keys(CATEGORY_CAPTURE_OPS).sort(), ['categories', 'category_members', 'network_stats'])
  const { request } = fakeRequest(() => ({ payload: categoryPayload(1) }))
  const writes: Record<string, unknown[]> = {}
  const viaOp = await CATEGORY_CAPTURE_OPS.categories(fakeDb({}, writes), ctxFor, NOW, 'basic', { request, policy: [] })
  eq(viaOp.job, 'categories')
  eq(viaOp.rows, 1)
  eq((await CATEGORY_CAPTURE_OPS.network_stats(fakeDb(), ctxFor, NOW, 'basic', { request, policy: [] })).skipped, 'plan_below_growth')
})
