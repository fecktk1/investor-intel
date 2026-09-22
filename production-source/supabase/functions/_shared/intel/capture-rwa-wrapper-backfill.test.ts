import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRwaWrapperBackfill, backfillParams, backfillPolicy, dailyCloses, seedAssets, reconstructAsset,
  RWA_WRAPPER_BACKFILL_OPS, RWA_WRAPPER_BACKFILL_IDS_PER_RUN, RWA_WRAPPER_BACKFILL_CREDIT_CEILING,
  BACKFILL_TABLE, BACKFILL_STATE_TABLE, BACKFILL_METHOD,
} from './capture-rwa-wrapper-backfill.ts'
import { ASSET_TABLE, TOKEN_TABLE } from './capture-rwa-wrappers.ts'
import { cmcParams, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { TROY_OUNCE_GRAMS } from './rwa-wrapper-spread.ts'

const DAY = 86_400_000
const FIRST = '2026-09-20T15:00:00.000Z'
const NOW = new Date('2026-09-22T12:00:00.000Z')
const POLICY = [{ provider: 'coinmarketcap', feature: 'rwa_wrapper_backfill', cadence_seconds: 86400, enabled: true, min_plan: 'startup', max_credits: 400 }]
const allow = (key: string) => (key === 'CMC_ALLOW_HISTORICAL_RETENTION' ? 'true' : undefined)

/** PostgREST-shaped fake: select/in/eq/order/limit, upsert honouring
 * ignoreDuplicates on the named key, and update().eq(). */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const store: Record<string, any[]> = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((r) => ({ ...r }))]))
  return {
    store,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(store[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => op === 'eq' ? String(row?.[key]) === String(operand)
            // deno-lint-ignore no-explicit-any
            : (operand as any[]).some((o) => String(o) === String(row?.[key])))
        }
        if (ordering) rows.sort((a, b) => String(a?.[ordering!.column]).localeCompare(String(b?.[ordering!.column])) * (ordering!.ascending ? 1 : -1))
        return { data: rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, o: any = {}) => { ordering = { column, ascending: o?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[], options: any = {}) => {
          if (errors[`${table}:write`]) return Promise.resolve({ error: { message: errors[`${table}:write`] } })
          const keys = String(options.onConflict).split(',')
          const list = (store[table] ||= [])
          for (const row of rows) {
            const at = list.findIndex((r) => keys.every((k) => String(r[k]) === String(row[k])))
            if (at < 0) list.push({ credits_spent: 0, attempts: 0, ...row })
            else if (!options.ignoreDuplicates) list[at] = { ...list[at], ...row }
          }
          return Promise.resolve({ error: null })
        },
        // deno-lint-ignore no-explicit-any
        update: (patch: any) => ({
          eq: (k: string, v: unknown) => {
            for (const row of store[table] || []) if (String(row[k]) === String(v)) Object.assign(row, patch)
            return Promise.resolve({ error: null })
          },
        }),
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })

// deno-lint-ignore no-explicit-any
function fakeRequest(handler: (params: Record<string, any>) => any) {
  // deno-lint-ignore no-explicit-any
  const calls: { name: string; params: Record<string, any> }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: Record<string, any> = {}) => { calls.push({ name, params }); return Promise.resolve(handler(params)) }
  return { request, calls }
}

/** A live-shaped ohlcv payload: one id, daily candles from `from`, the close
 * computed per day. */
const ohlcv = (id: string, from: string, days: number, close: (i: number) => number | null, volume = 5_000_000) => ({
  payload: {
    data: {
      id: Number(id), quotes: Array.from({ length: days }, (_, i) => {
        const t = Date.parse(from) + i * DAY
        return {
          time_open: new Date(t).toISOString(), time_close: new Date(t + DAY - 1).toISOString(),
          quote: { USD: { open: close(i), high: close(i), low: close(i), close: close(i), volume, market_cap: 1_000_000 + i } },
        }
      }),
    },
  },
  provenance: { fetchedAt: NOW.toISOString() },
})

// Gold as the live lane first captured it: two ounce wrappers and one gram wrapper.
const gold = {
  [ASSET_TABLE]: [
    { rwa_id: '1', captured_at: FIRST, symbol: 'GOLD', name: 'Gold', asset_type: 'commodity', rwa_rank: 1 },
    { rwa_id: '1', captured_at: '2026-09-21T02:00:00.000Z', symbol: 'GOLD', name: 'Gold', asset_type: 'commodity', rwa_rank: 1 },
  ],
  [TOKEN_TABLE]: [
    { rwa_id: '1', crypto_id: '5176', captured_at: FIRST, symbol: 'XAUT', name: 'Tether Gold', issuer_name: 'Tether' },
    { rwa_id: '1', crypto_id: '4705', captured_at: FIRST, symbol: 'PAXG', name: 'PAX Gold', issuer_name: 'Paxos' },
    { rwa_id: '1', crypto_id: '20245', captured_at: FIRST, symbol: 'CGO', name: 'Comtech Gold', issuer_name: 'Comtech' },
    // A later hour's wrapper is NOT part of the first-hour set.
    { rwa_id: '1', crypto_id: '99999', captured_at: '2026-09-21T02:00:00.000Z', symbol: 'NEW', name: 'Later Gold' },
  ],
}
const goldHandler = (params: Record<string, string>) => {
  if (params.id === '5176') return ohlcv('5176', '2026-09-15T00:00:00Z', 7, () => 4000)
  if (params.id === '4705') return ohlcv('4705', '2026-09-15T00:00:00Z', 7, () => 4040)
  if (params.id === '20245') return ohlcv('20245', '2026-09-15T00:00:00Z', 7, () => 4000 / TROY_OUNCE_GRAMS, 900_000)
  return null
}

Deno.test('one id per call at count 90 is exactly one credit, and the registry accepts it', () => {
  const params = backfillParams('5176')
  eq(params, { id: '5176', count: '90', interval: 'daily', time_period: 'daily' })
  eq(estimateCmcCredits('ohlcv', params), 1)
  // The canonical parameter builder accepts the request unchanged in meaning.
  const canonical = cmcParams('ohlcv', params)
  eq([canonical.id, canonical.count, canonical.interval, canonical.time_period], ['5176', '90', 'daily', 'daily'])
})

Deno.test('the lane refuses before any call: no row, disabled, no retention licence, plan below Startup', async () => {
  const cases: [unknown[], (k: string) => string | undefined, string, string][] = [
    [[], allow, 'startup', 'policy_disabled'],
    [[{ ...POLICY[0], enabled: false }], allow, 'startup', 'policy_disabled'],
    [POLICY, () => undefined, 'startup', 'historical_retention_not_permitted'],
    [POLICY, (k) => (k === 'CMC_ALLOW_HISTORICAL_RETENTION' ? 'false' : undefined), 'growth', 'historical_retention_not_permitted'],
    [POLICY, allow, 'basic', 'plan_below_startup'],
  ]
  for (const [policy, sourcePolicy, plan, skipped] of cases) {
    const db = fakeDb(gold)
    const { request, calls } = fakeRequest(goldHandler)
    // deno-lint-ignore no-explicit-any
    const result = await captureRwaWrapperBackfill(db, ctxFor, NOW, plan, { request, policy: policy as any, sourcePolicy })
    eq(result.skipped, skipped)
    eq(calls.length, 0)
    eq(result.credits, 0)
    eq(db.store[BACKFILL_STATE_TABLE], undefined)
  }
})

Deno.test('policy: max_credits is the standing ceiling, 400 by default', () => {
  eq(backfillPolicy({ request: () => Promise.resolve(null), policy: POLICY }), { enabled: true, maxCredits: 400 })
  eq(backfillPolicy({ request: () => Promise.resolve(null), policy: [{ ...POLICY[0], max_credits: null }] }).maxCredits, RWA_WRAPPER_BACKFILL_CREDIT_CEILING)
  eq(RWA_WRAPPER_BACKFILL_IDS_PER_RUN, 60)
})

Deno.test('a full asset: seeded from its first hour, one call per wrapper, days before the live capture only, unit guard applied', async () => {
  const db = fakeDb(gold)
  const { request, calls } = fakeRequest(goldHandler)
  const result = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow })
  eq(result.error, undefined)
  eq(calls.map((c) => c.params.id).sort(), ['20245', '4705', '5176'])
  assert(calls.every((c) => c.name === 'ohlcv' && !String(c.params.id).includes(',')))
  eq(result.credits, 3)
  eq(result.complete, 3)
  const rows = db.store[BACKFILL_TABLE]
  // 15..19 September: the 20th is the live capture day and the 21st is after it.
  eq([...new Set(rows.map((r) => r.day))].sort(), ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19'])
  eq(rows.length, 15)
  assert(rows.every((r) => r.method === BACKFILL_METHOD && r.wrapper_set_captured_at === FIRST && r.day < '2026-09-20'))
  const cgo = rows.find((r) => r.crypto_id === '20245' && r.day === '2026-09-15')
  eq(cgo.unit_state, 'normalised_troy_ounce')
  assert(Math.abs(cgo.normalised_price - 4000) < 1e-6)
  eq(cgo.market_cap, 1_000_000)
  const xaut = rows.find((r) => r.crypto_id === '5176' && r.day === '2026-09-15')
  eq(xaut.anchor_kind, 'liquid_wrapper_median')
  eq(xaut.anchor_members, 3)
  eq(xaut.in_anchor, true)
  assert(xaut.asset_dispersion_bps > 0)
  // The later wrapper was never seeded, so never bought.
  eq(db.store[BACKFILL_STATE_TABLE].map((r) => r.crypto_id).sort(), ['20245', '4705', '5176'])
  const state = db.store[BACKFILL_STATE_TABLE].find((r) => r.crypto_id === '5176')
  eq([state.state, state.credits_spent, state.attempts, state.days_written, state.first_day, state.last_day], ['complete', 1, 1, 5, '2026-09-15', '2026-09-19'])

  // A second run finds nothing to do and spends nothing.
  const again = fakeRequest(goldHandler)
  const second = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request: again.request, policy: POLICY, sourcePolicy: allow })
  eq(second.skipped, 'queue_empty')
  eq(again.calls.length, 0)
})

Deno.test('an accruing wrapper carries an accrual gap and never a premium', async () => {
  const tables = {
    [ASSET_TABLE]: [{ rwa_id: '7', captured_at: FIRST, symbol: 'USD', name: 'US Dollar Yield', asset_type: 'government_security' }],
    [TOKEN_TABLE]: [
      { rwa_id: '7', crypto_id: '100', captured_at: FIRST, symbol: 'A', name: 'Par Dollar A' },
      { rwa_id: '7', crypto_id: '101', captured_at: FIRST, symbol: 'B', name: 'Par Dollar B' },
      { rwa_id: '7', crypto_id: '29256', captured_at: FIRST, symbol: 'USDY', name: 'Ondo US Dollar Yield' },
    ],
  }
  const db = fakeDb(tables)
  const { request } = fakeRequest((p) => ohlcv(p.id, '2026-09-18T00:00:00Z', 2, () => (p.id === '29256' ? 1.1465 : 1)))
  await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow })
  const usdy = db.store[BACKFILL_TABLE].filter((r) => r.crypto_id === '29256')
  eq(usdy.length, 2)
  assert(usdy.every((r) => r.wrapper_state === 'accrues_in_price' && r.premium_bps === null && r.accrual_gap_bps > 1400))
})

Deno.test('a failed call writes nothing for the asset; the answered wrappers stay pending and are refetched', async () => {
  const db = fakeDb(gold)
  const failing = fakeRequest((p) => (p.id === '4705' ? { payload: null, reason: 'provider_unavailable' } : goldHandler(p)))
  const result = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request: failing.request, policy: POLICY, sourcePolicy: allow })
  eq(result.rows, 0)
  eq(result.failed, 1)
  eq(db.store[BACKFILL_TABLE], undefined)
  const byId = Object.fromEntries(db.store[BACKFILL_STATE_TABLE].map((r) => [r.crypto_id, r]))
  eq([byId['4705'].state, byId['4705'].attempts, byId['4705'].credits_spent], ['failed', 1, 0])
  eq([byId['5176'].state, byId['5176'].credits_spent], ['pending', 1])

  const retry = fakeRequest(goldHandler)
  const second = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request: retry.request, policy: POLICY, sourcePolicy: allow })
  eq(retry.calls.length, 3)
  eq(second.complete, 3)
  eq(db.store[BACKFILL_TABLE].length, 15)
  eq(second.creditsSpentToDate, 5)
})

Deno.test('the standing ceiling stops a run before an asset it cannot finish', async () => {
  const db = fakeDb({
    ...gold,
    [BACKFILL_STATE_TABLE]: [{ crypto_id: '777', rwa_id: '999', state: 'complete', credits_spent: 398, attempts: 1 }],
  })
  const { request, calls } = fakeRequest(goldHandler)
  const result = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow })
  eq(calls.length, 0)
  eq(result.partial, 'credit_budget')
  eq(result.budgetExhausted, true)
  const full = await captureRwaWrapperBackfill(fakeDb({ ...gold, [BACKFILL_STATE_TABLE]: [{ crypto_id: '777', rwa_id: '999', state: 'complete', credits_spent: 400 }] }),
    ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow })
  eq(full.skipped, 'credit_ceiling_reached')
})

Deno.test('an answer with no usable close is no_data, and still costs its credit', async () => {
  const db = fakeDb(gold)
  const { request } = fakeRequest((p) => (p.id === '20245' ? { payload: { data: { id: 20245, quotes: [] } }, provenance: { fetchedAt: NOW.toISOString() } } : goldHandler(p)))
  const result = await captureRwaWrapperBackfill(db, ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow })
  eq(result.noData, 1)
  eq(result.credits, 3)
  const cgo = db.store[BACKFILL_STATE_TABLE].find((r) => r.crypto_id === '20245')
  eq([cgo.state, cgo.reason, cgo.credits_spent], ['no_data', 'no_daily_close_reported', 1])
  // Without the gram wrapper the ounce pair still anchors.
  assert(db.store[BACKFILL_TABLE].every((r) => r.anchor_members === 2))
})

Deno.test('body.rwaId limits the run to one asset and rejects a malformed id', async () => {
  const bad = await RWA_WRAPPER_BACKFILL_OPS.rwa_wrapper_backfill(fakeDb(gold), ctxFor, NOW, 'startup',
    // deno-lint-ignore no-explicit-any
    { request: () => Promise.resolve(null), policy: POLICY, sourcePolicy: allow } as any, { rwaId: 'x' })
  eq(bad.error, 'invalid_rwa_id')
  const { request, calls } = fakeRequest(goldHandler)
  const other = await captureRwaWrapperBackfill(fakeDb(gold), ctxFor, NOW, 'startup', { request, policy: POLICY, sourcePolicy: allow }, { rwaId: '2' })
  eq(other.skipped, 'queue_empty')
  eq(calls.length, 0)
})

Deno.test('dailyCloses keeps completed candles strictly before the cutoff and drops a close that is not a price', () => {
  const { payload } = ohlcv('5', '2026-09-17T00:00:00Z', 6, (i) => (i === 1 ? 0 : 10))
  const closes = dailyCloses(payload, '5', '2026-09-20', NOW.getTime())
  eq(closes.map((c) => c.day), ['2026-09-17', '2026-09-19'])
  // The wrong id reads nothing.
  eq(dailyCloses(payload, '6', '2026-09-20', NOW.getTime()), [])
})

Deno.test('seedAssets takes the first hour per asset and only that hour\'s wrappers', () => {
  const seeds = seedAssets(gold[ASSET_TABLE], gold[TOKEN_TABLE])
  eq(seeds.get('1')!.firstCapturedAt, FIRST)
  eq([...seeds.get('1')!.wrappers.keys()].sort(), ['20245', '4705', '5176'])
  // A day with a single wrapper has no anchor and says why.
  const rows = reconstructAsset(seeds.get('1')!, new Map([['5176', [{ day: '2026-09-10', openAt: Date.parse('2026-09-10'), close: 4000, volume: 1e7, marketCap: null }]]]),
    { fetchedAt: NOW.toISOString(), floor: 250_000, sourceRefs: new Map() })
  eq(rows.length, 1)
  eq([rows[0].anchor_kind, rows[0].anchor_price, rows[0].premium_bps, rows[0].anchor_reason], ['none', null, null, 'not_enough_liquid_wrappers'])
})
