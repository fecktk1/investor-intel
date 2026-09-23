import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1'
import {
  captureRwaQuoteWarm, exampleIds, lanePolicy, loadWarmState, nextDue, warmIdSet, warmPlanRefusal,
  RWA_QUOTE_WARM_OPS, RWA_QUOTE_WARM_SCHEDULE, WARM_BATCH_CAP, WARM_EXAMPLE_SYMBOLS, WARM_LIST_PARAMS, WARM_PLAN_BACKOFF_MS, WARM_RETRY_MS, WARM_RUN_TABLE,
  type WarmDeps,
} from './capture-rwa-quote-warm.ts'
import { cmcParams } from '../market-assets/cmc-capabilities.ts'
import { researchParams } from './research-service.ts'

// The warm lane, asserted against the mechanism that holds each property: it
// calls only for an entry past its window, claims the free budget first, stops
// on a plan refusal and backs off, and names the batched entry readers consult.

const NOW = new Date('2026-09-24T10:00:30.000Z')
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

/** Just enough PostgREST for the lane's reads and its run row. */
function fakeDb(tables: Record<string, Row[]>) {
  let nextId = 1
  const log: Row[] = []
  return {
    tables, log,
    from(table: string) {
      let rows = [...(tables[table] || [])]
      let limit = Infinity, op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Row | null = null, single = false
      const filters: ((r: Row) => boolean)[] = []
      const q = {
        select() { return q },
        eq(k: string, v: unknown) { filters.push((r) => String(r[k]) === String(v)); return q },
        in(k: string, v: unknown[]) { filters.push((r) => v.map(String).includes(String(r[k]))); return q },
        lt(k: string, v: string) { filters.push((r) => Date.parse(r[k]) < Date.parse(v)); return q },
        order(k: string, o: { ascending: boolean }) { rows.sort((a, b) => (o.ascending ? 1 : -1) * String(a[k]).localeCompare(String(b[k]))); return q },
        limit(n: number) { limit = n; return q },
        insert(row: Row) { op = 'insert'; payload = row; return q },
        update(row: Row) { op = 'update'; payload = row; return q },
        delete() { op = 'delete'; return q },
        single() { single = true; return q },
        then(resolve: (v: unknown) => void) {
          const list = tables[table] ||= []
          if (op === 'insert') { const row = { id: nextId++, ...payload }; list.push(row); log.push({ op, table, row: { ...row } }); return resolve({ data: single ? { id: row.id } : [row], error: null }) }
          const hit = rows.filter((r) => filters.every((f) => f(r)))
          if (op === 'update') { for (const r of list) if (hit.includes(r)) Object.assign(r, payload); log.push({ op, table, payload }); return resolve({ data: null, error: null }) }
          if (op === 'delete') { tables[table] = list.filter((r) => !hit.includes(r)); log.push({ op, table, n: hit.length }); return resolve({ data: null, error: null }) }
          resolve({ data: hit.slice(0, limit), error: null })
        },
      }
      return q
    },
  }
}

const PROFILES = [
  { rwa_id: 2, symbol: 'NVDA', rwa_rank: 2 }, { rwa_id: 900, symbol: 'NVDA', rwa_rank: 5000 },
  { rwa_id: 242, symbol: 'SGOV', rwa_rank: 7773 }, { rwa_id: 1, symbol: 'GOLD', rwa_rank: 1 },
]
const WRAPPERS = [
  { rwa_id: '14', captured_at: '2026-09-24T08:00:00+00:00' }, { rwa_id: '1', captured_at: '2026-09-24T08:00:00+00:00' },
  { rwa_id: '86', captured_at: '2026-09-24T08:00:00+00:00' }, { rwa_id: '999', captured_at: '2026-09-24T02:00:00+00:00' },
]
const LIST_BODY = { status: { error_code: 0, credit_count: 1 }, data: { rwa_assets: [{ rwa_id: 1 }, { rwa_id: 2 }, { rwa_id: 3 }], total_size: 7942 } }
const QUOTES_BODY = { status: { error_code: 0, credit_count: 1 }, data: { rwa_assets: [{ rwa_id: 1 }] } }

const inWindow = (payload: unknown, fetchedAt = '2026-09-24T09:30:00.000Z') => ({ state: 'cached', reason: null, payload, receipt: { origin: 'cache', fetchedAt }, provenance: { fetchedAt, expiresAt: new Date(Date.parse(fetchedAt) + 3600_000).toISOString() } })
const stale = (payload: unknown, fetchedAt = '2026-09-24T08:58:00.000Z') => ({ state: 'stale', reason: null, payload, receipt: { origin: 'cache', fetchedAt }, provenance: { fetchedAt, expiresAt: new Date(Date.parse(fetchedAt) + 3600_000).toISOString() } })
const live = (payload: unknown) => ({ state: 'fresh', reason: null, payload, receipt: { origin: 'live', httpStatus: 200, creditCount: 1, fetchedAt: NOW.toISOString() }, provenance: { fetchedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 3600_000).toISOString() } })
// The Basic key after an event plan: the provider says no; the transport hands back the copy it had.
const refused = (payload: unknown) => ({ ...stale(payload), reason: 'insufficient_entitlement', receipt: { origin: 'cache', fetchedAt: '2026-09-24T08:58:00.000Z' } })
const refusedNoCopy = () => ({ state: 'unavailable', reason: 'insufficient_entitlement', payload: null, receipt: { origin: 'live', httpStatus: 402, creditCount: 0 }, provenance: { fetchedAt: null } })

const POLICY = [{ provider: 'coinmarketcap', feature: 'rwa_quote_warm', enabled: true, max_credits: 2, cadence_seconds: 3600 }]
const ctxFor = (name: string, maxCalls: number) => ({ caller: `intel-capture-${name}`, kind: 'job' as const, maxCalls })

function harness(opts: { cache: Record<string, () => Row>; live?: Record<string, () => Row>; claim?: boolean | string; runs?: Row[]; policy?: Row[] }) {
  const db = fakeDb({ [WARM_RUN_TABLE]: opts.runs ?? [], intel_rwa_asset_profiles: PROFILES, intel_rwa_wrapper_assets: WRAPPERS })
  const calls: { name: string; params: Row; kind: string | undefined; caller: string | undefined; noDemand: unknown }[] = []
  const claims: { capability: string; params: Row }[] = []
  const deps: WarmDeps = {
    policy: (opts.policy ?? POLICY) as WarmDeps['policy'],
    request: async (name, params = {}, ctx) => {
      calls.push({ name, params, kind: ctx?.kind, caller: ctx?.caller, noDemand: ctx?.noDemand })
      const table = ctx?.kind === 'render' ? opts.cache : (opts.live ?? {})
      return (table[name] ?? (() => ({ state: 'unavailable', reason: 'refresh_required', payload: null, provenance: {} })))()
    },
    claim: async (capability, params) => {
      claims.push({ capability, params })
      if (opts.claim === undefined || opts.claim === true) return { allowed: true, reason: null, cap: 200, used: 1 }
      return { allowed: false, reason: typeof opts.claim === 'string' ? opts.claim : 'free_rwa_budget_exhausted', cap: 200, used: 200 }
    },
  }
  return { db, deps, calls, claims, live: () => calls.filter((c) => c.kind !== 'render') }
}

Deno.test('the id set: examples, then the first list page, then the wrapper board; deduplicated, valid, capped, sorted', () => {
  assertEquals(warmIdSet({ examples: ['242', '2', '1'], listIds: ['1', '3', 'x', '0'], wrapperIds: ['14', '3'] }), ['1', '2', '3', '14', '242'])
  const many = Array.from({ length: 150 }, (_, i) => String(i + 1000))
  const capped = warmIdSet({ examples: ['2'], listIds: [], wrapperIds: many })
  assertEquals(capped.length, WARM_BATCH_CAP)
  assert(capped.includes('2'), 'an example is never the one cut by the cap')
})

Deno.test('examples resolve as the lookup resolves them: exact ticker, best rank', () => {
  assertEquals(exampleIds(PROFILES), ['2', '242', '1'])
  assertEquals([...WARM_EXAMPLE_SYMBOLS], ['NVDA', 'SGOV', 'GOLD'])
})

Deno.test('the examples are the ones the lookup page offers', async () => {
  const api = await Deno.readTextFile(new URL('../../../../src/intel/lib/rwa-lookup-api.js', import.meta.url))
  const offered = [...api.matchAll(/\{ q: '([A-Z]+)', key: 'example_/g)].map((m) => m[1]).sort()
  assertEquals(offered, [...WARM_EXAMPLE_SYMBOLS].sort())
})

Deno.test('the warmed list entry is the exact read the /intel/rwa first page makes', async () => {
  const page = await Deno.readTextFile(new URL('../../../../src/intel/pages/MarketResearchPage.jsx', import.meta.url))
  assertMatch(page, /const PAGE = 25\b/)
  assertMatch(page, /start: page \* PAGE \+ 1, limit: PAGE/)
  // Same canonical params, so the same shared cache key.
  assertEquals(JSON.stringify(cmcParams('rwaList', WARM_LIST_PARAMS)), JSON.stringify(cmcParams('rwaList', researchParams('rwaList', { start: 1, limit: 25 }))))
})

Deno.test('no policy row, or a disabled one: the lane does not run and spends nothing', async () => {
  assertEquals(lanePolicy({ request: async () => null, policy: [] }).enabled, false)
  const h = harness({ cache: {}, policy: [{ ...POLICY[0], enabled: false }] })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.skipped, 'policy_disabled'); assertEquals(h.calls.length, 0); assertEquals(h.claims.length, 0)
})

Deno.test('not due yet: nothing is read, claimed or written; force re-tests', async () => {
  const runs = [{ id: 7, ran_at: '2026-09-24T09:31:00.000Z', state: 'done', next_due_at: '2026-09-24T10:30:00.000Z', batch_ids: '1,2' }]
  const h = harness({ cache: { rwaList: () => inWindow(LIST_BODY), rwaQuotes: () => inWindow(QUOTES_BODY) }, runs })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.skipped, 'not_due'); assertEquals(h.calls.length, 0)
  const forced = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps, { force: true })
  assertEquals(forced.skipped, undefined); assertEquals(h.claims.length, 0, 'both entries were inside their window')
})

Deno.test('both entries inside their window: zero calls, zero claims, due again at the earlier expiry', async () => {
  const h = harness({ cache: { rwaList: () => inWindow(LIST_BODY, '2026-09-24T09:40:00.000Z'), rwaQuotes: () => inWindow(QUOTES_BODY, '2026-09-24T09:35:00.000Z') } })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.calls, 0); assertEquals(out.credits, 0); assertEquals(h.claims.length, 0); assertEquals(h.live().length, 0)
  const row = h.db.tables[WARM_RUN_TABLE][0]
  assertEquals(row.state, 'done')
  assertEquals(row.next_due_at, '2026-09-24T10:35:00.000Z')
  // The batch carries the examples, the list page and the newest wrapper board only.
  assertEquals(row.batch_ids, '1,2,3,14,86,242'); assertEquals(row.batch_size, 6)
})

Deno.test('entries past their window: one budget claim and one call each, no demand stamp, the batched ids in one read', async () => {
  const h = harness({
    cache: { rwaList: () => stale(LIST_BODY), rwaQuotes: () => stale(QUOTES_BODY) },
    live: { rwaList: () => live(LIST_BODY), rwaQuotes: () => live(QUOTES_BODY) },
  })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.calls, 2); assertEquals(out.credits, 2); assertEquals(h.claims.map((c) => c.capability), ['rwaList', 'rwaQuotes'])
  const liveCalls = h.live()
  assertEquals(liveCalls.map((c) => c.name), ['rwaList', 'rwaQuotes'])
  assertEquals(liveCalls[0].params, { start: 1, limit: 25 })
  assertEquals(liveCalls[1].params, { rwa_id: '1,2,3,14,86,242' })
  for (const c of liveCalls) { assertEquals(c.caller, 'intel-capture-rwa-quote-warm'); assertEquals(c.noDemand, true) }
  // The claim carries the same request, as strings.
  assertEquals(h.claims[1].params, { rwa_id: '1,2,3,14,86,242' })
  const row = h.db.tables[WARM_RUN_TABLE][0]
  assertEquals(row.calls, 2); assertEquals(row.claimed, 2); assertEquals(row.stop_reason, null)
  assertEquals(row.next_due_at, '2026-09-24T11:00:30.000Z')
})

Deno.test('a plan refusal stops the run at that call and backs off six hours; readers honour it', async () => {
  const h = harness({ cache: { rwaList: () => stale(LIST_BODY), rwaQuotes: () => stale(QUOTES_BODY) }, live: { rwaList: () => refused(LIST_BODY), rwaQuotes: () => live(QUOTES_BODY) } })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.stopReason, 'insufficient_entitlement')
  assertEquals(h.live().map((c) => c.name), ['rwaList'], 'nothing is asked after the plan said no')
  assertEquals(h.claims.length, 1)
  const row = h.db.tables[WARM_RUN_TABLE][0]
  assertEquals(row.stop_reason, 'insufficient_entitlement')
  const held = Date.parse(row.next_due_at) - NOW.getTime()
  assert(held >= WARM_PLAN_BACKOFF_MS && held < WARM_PLAN_BACKOFF_MS + 120_000, `backs off six hours (${held})`)
  // The batched entry readers consult is still named, and the refusal is readable.
  assertEquals(row.batch_ids, '1,2,3,14,86,242')
  const state = await loadWarmState(h.db)
  assertEquals(state?.stopReason, 'insufficient_entitlement')
  assertEquals(warmPlanRefusal(state, NOW.getTime() + 60_000), 'insufficient_entitlement')
  assertEquals(warmPlanRefusal(state, NOW.getTime() + WARM_PLAN_BACKOFF_MS + 180_000), null, 'and only until the backoff runs out')
})

Deno.test('a 402 with no copy to hand back is the same stop', async () => {
  const h = harness({ cache: { rwaList: () => stale(LIST_BODY), rwaQuotes: () => stale(QUOTES_BODY) }, live: { rwaList: () => refusedNoCopy() } })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.stopReason, 'insufficient_entitlement'); assertEquals(h.live().length, 1)
})

Deno.test('a spent free budget stops the run and waits for the next UTC day; nothing is called', async () => {
  const h = harness({ cache: { rwaList: () => stale(LIST_BODY), rwaQuotes: () => stale(QUOTES_BODY) }, claim: 'free_rwa_budget_exhausted' })
  const out = await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(out.calls, 0); assertEquals(h.live().length, 0); assertEquals(h.claims.length, 1)
  const row = h.db.tables[WARM_RUN_TABLE][0]
  assertEquals(row.stop_reason, 'free_rwa_budget_exhausted')
  assertEquals(row.next_due_at, '2026-09-25T00:01:00.000Z')
  assertEquals(warmPlanRefusal(await loadWarmState(h.db), NOW.getTime()), null, 'a spent budget is not a plan refusal readers should copy')
})

Deno.test('a transient failure retries in five minutes, and the old copy stays the answer', async () => {
  const h = harness({ cache: { rwaList: () => stale(LIST_BODY), rwaQuotes: () => inWindow(QUOTES_BODY) }, live: { rwaList: () => ({ ...stale(LIST_BODY), reason: 'provider_unavailable' }) } })
  await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  const row = h.db.tables[WARM_RUN_TABLE][0]
  assertEquals(row.stop_reason, null)
  const wait = Date.parse(row.next_due_at) - NOW.getTime()
  assert(wait >= WARM_RETRY_MS && wait < WARM_RETRY_MS + 120_000, `retries in five minutes (${wait})`)
  // The list ids still came from the copy it had.
  assertEquals(row.batch_ids, '1,2,3,14,86,242')
})

Deno.test('the run row is written first as running, then finished; the log keeps two weeks', async () => {
  const old = { id: 99, ran_at: '2026-09-01T00:00:00.000Z', state: 'done', next_due_at: '2026-09-01T01:00:00.000Z' }
  const h = harness({ cache: { rwaList: () => inWindow(LIST_BODY), rwaQuotes: () => inWindow(QUOTES_BODY) }, runs: [old] })
  await captureRwaQuoteWarm(h.db, ctxFor, NOW, h.deps)
  assertEquals(h.db.log[0].op, 'insert'); assertEquals(h.db.log[0].row.state, 'running')
  assertEquals(h.db.log[1].op, 'update')
  assertEquals(h.db.log[2].op, 'delete')
  assert(!h.db.tables[WARM_RUN_TABLE].some((r) => r.id === 99), 'a run older than 14 days is pruned')
})

Deno.test('nextDue: never sooner than a minute, the earlier expiry, and a missing expiry is a retry', () => {
  const now = Date.parse('2026-09-24T10:00:00.000Z')
  assertEquals(nextDue({ now, stopReason: null, transient: false, expiries: ['2026-09-24T10:50:00.000Z', '2026-09-24T10:40:00.000Z'] }), '2026-09-24T10:40:00.000Z')
  assertEquals(nextDue({ now, stopReason: null, transient: false, expiries: ['2026-09-24T09:00:00.000Z'] }), '2026-09-24T10:01:00.000Z')
  assertEquals(nextDue({ now, stopReason: null, transient: false, expiries: [null] }), '2026-09-24T10:05:00.000Z')
  assertEquals(nextDue({ now, stopReason: 'free_rwa_lane_disabled', transient: false, expiries: [] }), '2026-09-24T11:00:00.000Z')
})

// ─── The migration, the schedule and the wiring ─────────────────────────────

const sql = await Deno.readTextFile(new URL('../../../migrations/20260923160000_intel_rwa_quote_warm.sql', import.meta.url))

Deno.test('the migration schedules the stated job every minute, POSTing only when due, from vault', () => {
  const lane = RWA_QUOTE_WARM_SCHEDULE.rwa_quote_warm
  const m = sql.match(/SELECT cron\.schedule\('([^']+)', '([^']+)', \$\$([\s\S]*?)\$\$\);/)
  assert(m, 'a cron.schedule call')
  assertEquals(m![1], lane.job); assertEquals(m![2], lane.cron)
  assert(sql.includes(`SELECT cron.unschedule('${lane.job}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${lane.job}');`))
  const body = m![3]
  assertMatch(body, /jsonb_build_object\('op','rwa_quote_warm'\)/)
  assertMatch(body, /WHERE public\.intel_rwa_quote_warm_due\(\);\s*$/)
  for (const secret of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']) assert(body.includes(`(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${secret}')`), secret)
  assertMatch(body, /'x-cron-secret'/)
  assertMatch(body, /timeout_milliseconds := 110000/)
  assert(!/eyJ[A-Za-z0-9_-]{10,}/.test(sql) && !/Bearer [A-Za-z0-9]/.test(sql), 'no literal credential')
})

Deno.test('the run log and the due check are service role only; the policy row is on with a 2 credit ceiling', () => {
  for (const role of ['PUBLIC', 'anon', 'authenticated']) {
    assert(sql.includes(`REVOKE ALL ON public.intel_rwa_quote_warm_runs FROM ${role};`), role)
    assert(sql.includes(`REVOKE ALL ON FUNCTION public.intel_rwa_quote_warm_due() FROM ${role};`), role)
  }
  assertMatch(sql, /ALTER TABLE public\.intel_rwa_quote_warm_runs ENABLE ROW LEVEL SECURITY;/)
  assertMatch(sql, /SECURITY INVOKER/)
  assertMatch(sql, /\('coinmarketcap', 'rwa_quote_warm', 3600, true, NULL, 2,/)
  assertMatch(sql, /ON CONFLICT \(provider, feature\) DO NOTHING;/)
  // The batch column holds exactly what the transport keys the entry by.
  assertMatch(sql, /\{0,99\}\$'\)/)
})

Deno.test('the op is registered in intel-capture, so a tick never answers unsupported_op', async () => {
  const index = await Deno.readTextFile(new URL('../../intel-capture/index.ts', import.meta.url))
  assertMatch(index, /\.\.\.RWA_QUOTE_WARM_OPS/)
  assert('rwa_quote_warm' in RWA_QUOTE_WARM_OPS)
})
