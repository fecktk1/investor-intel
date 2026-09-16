import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readNewListings, flagCount, medianOf, LISTING_CAPTURE_VIEWS, LISTING_VIEWS } from './capture-listings-read.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const dayOf = (d: number) => daysAgo(d).slice(0, 10)
const EVM = '0x' + 'a'.repeat(40)
const HASH = (c: string) => c.repeat(64)

/** Minimal PostgREST-shaped fake; every read chain ends in `.limit()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const compare = (a: unknown, b: unknown) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  const calls: unknown[][] = []
  return {
    calls,
    from(table: string) {
      calls.push(['from', table])
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean; nullsFirst: boolean } | null = null
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
        if (ordering) {
          const o = ordering
          rows.sort((a, b) => {
            const [x, y] = [a?.[o.column], b?.[o.column]]
            if (x == null && y == null) return 0
            if (x == null) return o.nullsFirst ? -1 : 1
            if (y == null) return o.nullsFirst ? 1 : -1
            return compare(x, y) * (o.ascending ? 1 : -1)
          })
        }
        return { data: rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { calls.push(['eq', k, v]); filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { calls.push(['gte', k, v]); filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        lte: (k: string, v: any) => { calls.push(['lte', k, v]); filters.push([k, 'lte', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false, nullsFirst: options?.nullsFirst === true }; return q },
        limit: (max: number) => { calls.push(['limit', max]); return Promise.resolve(run(max)) },
      }
      return q
    },
  }
}

const doc = (hits: boolean[]) => ({ exists: true, level: 2, items: hits.map((hit, i) => ({ code: `c${i}`, hit, level: 1, description: 'x' })) })

const snapshot = (over: Record<string, unknown> = {}) => ({
  provider: 'coinmarketcap', provider_id: '1', snapshot_date: dayOf(0), symbol: 'NEW', name: 'New Thing', slug: 'new-thing',
  date_added: daysAgo(0), chain: 'eip155:8453', contract_address: EVM,
  price: 0.5, market_cap: 1e6, volume_24h: 2e5, change_24h_pct: -4,
  holder_count: 100, security: doc([false]), security_hash: HASH('a'), security_state: 'captured', captured_at: daysAgo(0), ...over,
})

// ─── helpers ──────────────────────────────────────────────────────────────────

Deno.test('the flag count counts reported hits only, and absence of a document is not zero flags', () => {
  eq(flagCount(doc([true, false, true])), 2)
  eq(flagCount(doc([])), 0, 'an inspected contract with no flags is a real zero')
  eq(flagCount(null), null)
  eq(flagCount({ items: 'nope' }), null)
  eq(flagCount('x'), null)
})

Deno.test('a median over nothing is null, never zero', () => {
  eq(medianOf([]), null)
  eq(medianOf([5]), 5)
  eq(medianOf([3, 1, 2]), 2)
  eq(medianOf([4, 1, 3, 2]), 2.5)
  eq(medianOf([0, 0]), 0, 'a cohort that really has no holders has a median of zero')
})

// ─── the view ─────────────────────────────────────────────────────────────────

Deno.test('an empty table is an empty list with no asOf and no invented cohort', async () => {
  const r = await readNewListings(fakeDb(), {}, NOW)
  eq(r.view, 'new_listings')
  eq(r.days, 7, 'the default window')
  eq(r.status, 'all')
  eq(r.rows, [])
  eq(r.asOf, null)
  eq(r.cohort, { count: 0, withContract: 0, flagged: 0, medianHolderCount: null })
  eq(r.coverage, { from: null, to: null, count: 0 })
  eq(r.reason, null)
})

Deno.test('the window is 7, 30 or 90 days and anything else falls back rather than widening the read', async () => {
  const db = fakeDb({ intel_new_listing_snapshots: [snapshot()] })
  for (const [asked, expected] of [[7, 7], [30, 30], [90, 90], [365, 7], [0, 7], ['soon', 7], [undefined, 7]] as [unknown, number][]) {
    eq((await readNewListings(db, { days: asked }, NOW)).days, expected)
  }
  const gte = db.calls.filter((c) => c[0] === 'gte' && c[1] === 'snapshot_date')
  eq(gte.at(-1)?.[2], dayOf(7), 'an unrecognised window reads seven days, not everything')
  eq(db.calls.some((c) => c[0] === 'from' && c[1] === 'intel_new_listing_snapshots'), true)
})

Deno.test('one row per asset, newest snapshot, with the cohort summary', async () => {
  const rows = [
    snapshot({ provider_id: '1', snapshot_date: dayOf(0), holder_count: 100, security: doc([true, false]), captured_at: daysAgo(0) }),
    snapshot({ provider_id: '1', snapshot_date: dayOf(2), holder_count: 40, security: doc([false, false]), security_hash: HASH('b'), captured_at: daysAgo(2) }),
    snapshot({ provider_id: '2', symbol: 'TWO', date_added: daysAgo(1), snapshot_date: dayOf(1), holder_count: 300, security: doc([false]), captured_at: daysAgo(1) }),
    snapshot({ provider_id: '3', symbol: 'OFF', date_added: daysAgo(3), snapshot_date: dayOf(3), chain: null, contract_address: null, holder_count: null, security: null, security_hash: null, security_state: 'no_contract_on_verified_chain', captured_at: daysAgo(3) }),
  ]
  const r = await readNewListings(fakeDb({ intel_new_listing_snapshots: rows }), { days: 7 }, NOW)
  // deno-lint-ignore no-explicit-any
  const out = r.rows as any[]
  eq(out.length, 3, 'three assets, not four snapshots')
  eq(out.map((row) => row.providerId), ['1', '2', '3'], 'newest listing first')
  eq(out[0].holderCount, 100, 'the newest snapshot supplies the values')
  eq(out[0].flagCount, 1)
  eq(out[0].snapshots, 2)
  eq(out[0].firstSeenAt, daysAgo(2))
  eq(out[0].lastSeenAt, daysAgo(0))
  eq(out[0].changed, true, 'the hash moved between the two snapshots of this asset')
  eq(out[1].changed, false, 'one snapshot is a baseline, never a change')
  eq(out[2].flagCount, null, 'a listing nobody could inspect has no flag count at all')
  eq(out[2].securityState, 'no_contract_on_verified_chain')
  eq(r.cohort, { count: 3, withContract: 2, flagged: 1, medianHolderCount: 200 })
  eq(r.changed, 1)
  eq(r.asOf, daysAgo(0))
  eq(r.coverage.from, daysAgo(3))
  eq(r.coverage.to, daysAgo(0))
  eq(r.coverage.count, 4)
  eq(r.coverage.truncated, false)
})

Deno.test('the returned row carries exactly the documented shape', async () => {
  const r = await readNewListings(fakeDb({ intel_new_listing_snapshots: [snapshot()] }), {}, NOW)
  // deno-lint-ignore no-explicit-any
  const row = (r.rows as any[])[0]
  eq(Object.keys(row).sort(), [
    'chain', 'change24hPct', 'changed', 'contractAddress', 'dateAdded', 'firstSeenAt', 'flagCount', 'holderCount',
    'lastSeenAt', 'marketCap', 'name', 'price', 'providerId', 'securityState', 'security', 'slug', 'snapshots', 'symbol', 'volume24h',
  ].sort())
  eq(row.chain, 'eip155:8453')
  eq(row.contractAddress, EVM)
  eq(row.price, 0.5)
  eq(row.marketCap, 1e6)
  eq(row.volume24h, 2e5)
  eq(row.change24hPct, -4)
  assert(row.security && typeof row.security === 'object', 'the whitelisted flag document is passed through')
})

Deno.test('the flagged filter narrows the rows but never the cohort it is measured against', async () => {
  const rows = [
    snapshot({ provider_id: '1', security: doc([true]) }),
    snapshot({ provider_id: '2', date_added: daysAgo(1), snapshot_date: dayOf(1), security: doc([false]), captured_at: daysAgo(1) }),
    snapshot({ provider_id: '3', date_added: daysAgo(2), snapshot_date: dayOf(2), security: null, security_hash: null, security_state: 'rate_limited', captured_at: daysAgo(2) }),
  ]
  const db = fakeDb({ intel_new_listing_snapshots: rows })
  const all = await readNewListings(db, { status: 'all' }, NOW)
  eq((all.rows as unknown[]).length, 3)
  const flagged = await readNewListings(db, { status: 'flagged' }, NOW)
  eq((flagged.rows as unknown[]).length, 1)
  // deno-lint-ignore no-explicit-any
  eq((flagged.rows as any[])[0].providerId, '1')
  eq(flagged.cohort, all.cohort, 'the cohort still describes every listing in the window')
  eq((await readNewListings(db, { status: 'whatever' }, NOW)).status, 'all', 'an unrecognised status shows everything rather than hiding rows')
})

Deno.test('a changed hash is only asserted when both sides were actually inspected', async () => {
  const pair = (a: string | null, b: string | null) => [
    snapshot({ provider_id: '9', snapshot_date: dayOf(0), security_hash: a, security: a ? doc([true]) : null, security_state: a ? 'captured' : 'rate_limited', captured_at: daysAgo(0) }),
    snapshot({ provider_id: '9', snapshot_date: dayOf(1), security_hash: b, security: b ? doc([false]) : null, security_state: b ? 'captured' : 'due_diligence_budget', captured_at: daysAgo(1) }),
  ]
  // deno-lint-ignore no-explicit-any
  const changed = async (a: string | null, b: string | null) => ((await readNewListings(fakeDb({ intel_new_listing_snapshots: pair(a, b) }), {}, NOW)).rows as any[])[0].changed
  eq(await changed(HASH('a'), HASH('b')), true)
  eq(await changed(HASH('a'), HASH('a')), false, 'the same flags are not a change')
  eq(await changed(HASH('a'), null), false, 'a first inspection is a baseline, not a change')
  eq(await changed(null, HASH('b')), false, 'losing coverage is not a change')
  eq(await changed(null, null), false)
})

Deno.test('a failed read is a reason on an empty result, never a silently short list', async () => {
  const r = await readNewListings(fakeDb({}, { intel_new_listing_snapshots: 'read_denied' }), { days: 30 }, NOW)
  eq(r.rows, [])
  eq(r.reason, 'read_denied')
  eq(r.asOf, null)
  eq(r.days, 30)
  eq(r.cohort, { count: 0, withContract: 0, flagged: 0, medianHolderCount: null })

  const exploded = await readNewListings({ from: () => { throw new Error('boom') } }, {}, NOW)
  eq(exploded.reason, 'boom', 'a throwing db is reported, never re-thrown')
})

Deno.test('a row with no provider id is dropped and a cohort with no counts has no median', async () => {
  const r = await readNewListings(fakeDb({
    intel_new_listing_snapshots: [
      snapshot({ provider_id: null }),
      snapshot({ provider_id: '5', holder_count: null, security: null, security_hash: null, security_state: 'no_contract_on_verified_chain', chain: null, contract_address: null }),
    ],
  }), {}, NOW)
  eq((r.rows as unknown[]).length, 1)
  eq((r.cohort as Record<string, unknown>).medianHolderCount, null, 'nothing counted is null, not zero')
  eq((r.cohort as Record<string, unknown>).withContract, 0)
})

Deno.test('the view surface exposes exactly the one view and routes through it', async () => {
  eq(Object.keys(LISTING_CAPTURE_VIEWS), ['new_listings'])
  eq([...LISTING_VIEWS], ['new_listings'])
  const r = await LISTING_CAPTURE_VIEWS.new_listings(fakeDb({ intel_new_listing_snapshots: [snapshot()] }), { days: 90 }, NOW.getTime())
  eq(r.view, 'new_listings')
  eq(r.days, 90)
  eq((r.rows as unknown[]).length, 1)
})

Deno.test('one chain cannot fill a day of listings, and no day is reordered against another', async () => {
  const wave = Array.from({ length: 8 }, (_, i) => snapshot({ provider_id: `s${i}`, symbol: `S${i}`, chain: 'solana', date_added: `${dayOf(1)}T0${9 - i}:00:00.000Z`, snapshot_date: dayOf(1), captured_at: daysAgo(1) }))
  const other = snapshot({ provider_id: 'b1', symbol: 'B1', chain: 'eip155:8453', date_added: `${dayOf(1)}T00:30:00.000Z`, snapshot_date: dayOf(1), captured_at: daysAgo(1) })
  const today = snapshot({ provider_id: 't1', symbol: 'T1', chain: 'solana', date_added: daysAgo(0), snapshot_date: dayOf(0), captured_at: daysAgo(0) })
  const r = await readNewListings(fakeDb({ intel_new_listing_snapshots: [...wave, other, today] }), { days: 7 }, NOW)
  // deno-lint-ignore no-explicit-any
  const out = (r.rows as any[]).map((row) => row.providerId)
  eq(out.length, 10, 'the cap drops nothing')
  eq(out[0], 't1', 'the newer day still leads')
  eq(out.slice(1, 7), ['s0', 's1', 's2', 's3', 's4', 'b1'], 'the other chain moves ahead of the sixth solana listing of the same day')
  eq(out.slice(7), ['s5', 's6', 's7'])
  eq((r.cohort as Record<string, unknown>).count, 10, 'the cohort is counted before the cap')
})
