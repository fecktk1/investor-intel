import { assert, assertEquals as eq, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  buildDemoSnapshot, computeEntry, finalizePlan, scrubBody, PersonalDataError, type DemoRequest,
} from './demo-snapshot-builder.ts'
import { captureReadEnvelope, CAPTURE_READ_VIEWS, LANE_VIEWS } from './capture-read-envelope.ts'
import { readCaptureView } from './capture-read.ts'
import { planDemoRequests, staticCaptureRequests, topProviderIds, WRAPPER_HISTORY_DAYS } from './demo-snapshot-plan.ts'
import { cacheOnlyResearchReader } from './demo-snapshot-research.ts'
import { demoSnapshotKey, DEMO_LATEST_PATH, DEMO_SNAPSHOT_KEY_VERSION } from './demo-snapshot-key.ts'
import { fakeDb, forbidNetwork, memoryStorage } from './demo-snapshot-fakes.test-helpers.ts'

const NOW = Date.parse('2026-09-23T04:13:00.000Z')
const env = (key: string) => (key === 'CMC_ALLOW_EXPORT' ? 'false' : undefined)
const withoutClock = (body: Record<string, unknown>) => { const { durationMs: _d, ...rest } = body; return rest }

const universeRows = [
  { asset_type: 'treasury', captured_at: '2026-09-23T03:00:00.000Z', asset_count: 40, assets_scanned: 800, assets_with_tokens: 90, issuer_count: 12, total_market_value_usd: 7.5e9, volume_24h_usd: 1e8, change_24h_pct: null, top_assets: [] },
  { asset_type: 'treasury', captured_at: '2026-09-22T03:00:00.000Z', asset_count: 39, assets_scanned: 800, assets_with_tokens: 88, issuer_count: 12, total_market_value_usd: 7.4e9, volume_24h_usd: 9e7, change_24h_pct: null, top_assets: [] },
]

// ─── envelope parity ─────────────────────────────────────────────────────────

Deno.test('the shared envelope is intel-capture\'s read: view result + sourcePolicy + durationMs', async () => {
  const db = fakeDb({ intel_rwa_universe_snapshots: universeRows })
  const direct = await readCaptureView(db, 'rwa_universe', { view: 'rwa_universe' }, NOW)
  const read = await captureReadEnvelope(db, { op: 'read', view: 'rwa_universe' }, { now: NOW, startedAt: Date.now(), env })
  eq(read.status, 200)
  eq(withoutClock(read.body), { ...direct, sourcePolicy: { exportAllowed: false } })
  assert(typeof read.body.durationMs === 'number')
  // A lane view goes through LANE_VIEWS with the whole body, exactly as before.
  const lane = await captureReadEnvelope(db, { op: 'read', view: 'rwa_coverage' }, { now: NOW, startedAt: Date.now(), env: () => 'true' })
  eq(withoutClock(lane.body), { ...await LANE_VIEWS.rwa_coverage(db, { op: 'read', view: 'rwa_coverage' }, NOW), sourcePolicy: { exportAllowed: true } })
})

Deno.test('an unknown view is the same 400 intel-capture always answered', async () => {
  const read = await captureReadEnvelope(fakeDb(), { op: 'read', view: 'nope' }, { now: NOW, startedAt: Date.now(), env })
  eq(read.status, 400)
  eq(read.body.error, 'unsupported_view')
  eq(read.body.views, CAPTURE_READ_VIEWS)
})

Deno.test('every lane view the app reads is registered in the shared envelope', () => {
  for (const view of ['rwa_coverage', 'rwa_universe_changes', 'rwa_concentration', 'rwa_depth', 'rwa_token_depth', 'rwa_wrappers', 'rwa_wrapper_picks',
    'rwa_wrapper_history', 'rwa_yield', 'rwa_issuer_legitimacy', 'rwa_underlying_registrants', 'rwa_asset_profile', 'rwa_asset_logos', 'unusual_moves',
    'exchange_reserves', 'venue_share', 'categories', 'category_disagreement', 'airdrops', 'network_stats', 'fx', 'new_listings', 'meme_graduation']) {
    assert(Object.hasOwn(LANE_VIEWS, view), `${view} missing from LANE_VIEWS`)
  }
})

Deno.test('intel-capture answers its read half through the shared envelope', async () => {
  const source = await Deno.readTextFile(new URL('../../intel-capture/index.ts', import.meta.url))
  assert(source.includes("import { captureReadEnvelope } from '../_shared/intel/capture-read-envelope.ts'"))
  assert(/const read = await captureReadEnvelope\(admin, body, \{ now: Date\.now\(\), startedAt, env: \(key\) => Deno\.env\.get\(key\) \}\)\s+return json\(read\.body, read\.status\)/.test(source))
  // The membership gate still runs first.
  assert(source.indexOf('requireIntelAccess(req, createClient, admin, orgId)') < source.indexOf('captureReadEnvelope(admin'))
})

Deno.test('the builder stores exactly the envelope body for a capture request', async () => {
  const db = fakeDb({ intel_rwa_universe_snapshots: universeRows })
  const entry = await computeEntry({ fn: 'intel-capture', body: { op: 'read', view: 'rwa_universe' } }, { db, storage: memoryStorage(), env }, NOW)
  const read = await captureReadEnvelope(db, { op: 'read', view: 'rwa_universe' }, { now: NOW, startedAt: Date.now(), env })
  eq(entry?.status, 200)
  eq(withoutClock(entry!.body as Record<string, unknown>), withoutClock(read.body))
  eq(await computeEntry({ fn: 'intel-capture', body: { op: 'read', view: 'nope' } }, { db, storage: memoryStorage(), env }, NOW), null)
})

// ─── enumeration ─────────────────────────────────────────────────────────────

Deno.test('variants are enumerated from the data: history per asset x range, depth per token, liquidations from the rank map', async () => {
  const series = [{ providerId: '1', points: [{ date: '2026-09-21', rank: 1 }] }, { providerId: '1027', points: [{ date: '2026-09-21', rank: 2 }] }]
  const db = fakeDb()
  const discovery: Record<string, unknown> = {
    rank_map: { series },
    rwa_wrappers: { rows: [{ rwaId: '11', wrappers: [{ cryptoId: '5176' }, { cryptoId: '20245' }] }] },
    rwa_wrapper_history: { assets: [{ rwaId: '11' }, { rwaId: '12' }] },
    rwa_depth: { rows: [{ cryptoId: '5176' }, { cryptoId: '30000' }] },
  }
  const pages = [[{ rwa_id: 3 }, { rwa_id: 1 }], [{ rwa_id: 2 }]]
  const research = async (capability: string, params: Record<string, unknown>) => {
    if (capability === 'rwaList') { const page = pages[(Number(params.start) - 1) / 25]; return page ? { data: { rows: page, hasMore: Number(params.start) === 1 } } : null }
    if (capability === 'issuers') return Number(params.start) === 1 ? { data: { rows: [{ issuer_id: 77 }], hasMore: false } } : null
    return null
  }
  const plan = await planDemoRequests(db, NOW, { research, discover: async (body) => discovery[String(body.view)] ?? null })
  const keys = new Set(plan.map((r) => demoSnapshotKey(r.fn, r.body)))
  const has = (fn: string, body: Record<string, unknown>) => keys.has(demoSnapshotKey(fn, body))
  for (const rwaId of ['11', '12']) for (const days of WRAPPER_HISTORY_DAYS) assert(has('intel-capture', { op: 'read', view: 'rwa_wrapper_history', rwaId, days }), `${rwaId}/${days}`)
  assert(has('intel-capture', { op: 'read', view: 'rwa_wrapper_picks', rwaId: '11' }))
  for (const cryptoId of ['5176', '20245', '30000']) assert(has('intel-capture', { op: 'read', view: 'rwa_token_depth', cryptoId }), cryptoId)
  eq(topProviderIds({ series }), ['1', '1027'])
  assert(has('intel-capture', { op: 'read', view: 'liquidations', providerIds: ['1', '1027'] }))
  // /intel/rwa: both list pages, one sorted logo batch per page, the drawers.
  assert(has('intel-research', { capability: 'rwaList', params: { start: 1, limit: 25 } }))
  assert(has('intel-research', { capability: 'rwaList', params: { start: 26, limit: 25 } }))
  // Each asset-type filter the page offers gets its own first page.
  assert(has('intel-research', { capability: 'rwaList', params: { start: 1, limit: 25, asset_type: 'government_security' } }))
  assert(has('intel-capture', { op: 'read', view: 'rwa_asset_logos', rwaIds: [1, 3] }))
  assert(has('intel-capture', { op: 'read', view: 'rwa_asset_logos', rwaIds: [2] }))
  for (const id of [1, 2, 3]) {
    assert(has('intel-research', { capability: 'rwaInfo', params: { rwa_id: id } }))
    assert(has('intel-research', { capability: 'rwaQuotes', params: { rwa_id: id } }))
    assert(has('intel-research', { capability: 'rwaPairs', params: { rwa_id: id, limit: 25 } }))
    assert(has('intel-capture', { op: 'read', view: 'rwa_asset_profile', rwaId: id }))
  }
  assert(has('intel-research', { capability: 'issuer', params: { issuer_id: 77 } }))
  assert(has('intel-research', { capability: 'issuer', params: { issuer_id: 77, limit: 25 } }))
  // Every static page request is in, and nothing is planned twice.
  for (const r of staticCaptureRequests(NOW)) assert(keys.has(demoSnapshotKey(r.fn, r.body)))
  eq(finalizePlan(plan).length, keys.size)
})

// ─── the run ─────────────────────────────────────────────────────────────────

const requests = (n: number): DemoRequest[] => Array.from({ length: n }, (_, i) => ({ fn: 'intel-research', body: { capability: 'rwaInfo', params: { rwa_id: i + 1 } } }))
const researchBody = (params: Record<string, unknown>) => ({ version: 1, capability: 'rwaInfo', state: 'cached', data: { rows: [{ rwa_id: params.rwa_id }] }, freeShared: { lane: 'rwa_research', served: 'shared-cache' } })


// Follows the hand-offs the deployed function makes: the first invocation only
// plans, and each later one resumes from the cursor the previous one returned.
async function runAll(deps: Parameters<typeof buildDemoSnapshot>[0], opts: Parameters<typeof buildDemoSnapshot>[1]) {
  let cursor: number | null = null, invocations = 0, written = 0, failed = 0, skipped = 0
  let last = await buildDemoSnapshot(deps, opts)
  for (;;) {
    invocations++; written += last.written; failed += last.failed; skipped += last.skipped
    if (last.status !== 'partial' || invocations > 1000) break
    cursor = last.cursor
    last = await buildDemoSnapshot(deps, { ...opts, cursor })
  }
  return { ...last, written, failed, skipped, invocations }
}

Deno.test('a run writes every entry, then latest.json LAST, and logs one append-only run row', async () => {
  const db = fakeDb(), storage = memoryStorage()
  const result = await runAll({ db, storage, env, now: () => NOW, planner: async () => requests(5), research: async (_c, p) => researchBody(p) }, { trigger: 'cron' })
  eq(result.status, 'complete')
  eq(result.written, 5)
  eq(result.invocations, 2, 'one planning invocation, then one that writes all five')
  eq(storage.order.at(-1), DEMO_LATEST_PATH)
  const latest = JSON.parse(storage.files.get(DEMO_LATEST_PATH)!)
  eq(latest.date, '2026-09-23')
  eq(latest.keys.length, 5)
  for (const key of latest.keys) assert(storage.files.has(`snapshots/2026-09-23/${key}.json`))
  const runRows = db.writes.filter((w) => w.table === 'intel_demo_snapshot_runs')
  eq(runRows.length, result.invocations)
  assert(runRows.every((w) => w.op === 'insert'), 'the run log is append-only')
  // A second tick the same day does nothing.
  db.tables.intel_demo_snapshot_runs = [{ snapshot_date: '2026-09-23', latest_written: true, status: 'complete', resume_cursor: null }]
  eq((await buildDemoSnapshot({ db, storage, env, now: () => NOW, planner: async () => requests(5) }, { trigger: 'cron' })).status, 'already_built')
})

Deno.test('a run that hits its budget stops with a cursor and the next invocation resumes over the same plan', async () => {
  const db = fakeDb(), storage = memoryStorage()
  let clock = NOW, plannerCalls = 0
  const research = async (_c: string, p: Record<string, unknown>) => { clock += 4000; return researchBody(p) }
  const planned = await buildDemoSnapshot({ db, storage, env, now: () => clock, planner: async () => { plannerCalls++; return requests(12) }, research },
    { trigger: 'cron', budgetMs: 5000, concurrency: 2 })
  eq(planned.status, 'partial')
  eq(planned.cursor, 0, 'the planning invocation computes no entry')
  eq(planned.written, 0)
  const first = await buildDemoSnapshot({ db, storage, env, now: () => clock, planner: async () => { plannerCalls++; return requests(99) }, research },
    { trigger: 'cron', budgetMs: 5000, concurrency: 2, cursor: 0 })
  eq(first.status, 'partial')
  assert(first.cursor! > 0 && first.cursor! < 12)
  assert(!storage.files.has(DEMO_LATEST_PATH), 'no manifest before the plan is finished')
  const second = await buildDemoSnapshot({ db, storage, env, now: () => clock, planner: async () => { plannerCalls++; return requests(99) }, research },
    { trigger: 'cron', budgetMs: 10_000_000, cursor: first.cursor })
  eq(second.status, 'complete')
  eq(plannerCalls, 1, 'the stored plan is reused, not re-planned')
  eq(first.written + second.written, 12)
  eq(JSON.parse(storage.files.get(DEMO_LATEST_PATH)!).keys.length, 12)
})

Deno.test('one invocation computes at most maxEntriesPerRun entries, then hands on', async () => {
  const db = fakeDb(), storage = memoryStorage()
  const deps = { db, storage, env, now: () => NOW, planner: async () => requests(7), research: async (_c: string, p: Record<string, unknown>) => researchBody(p) }
  await buildDemoSnapshot(deps, { trigger: 'cron' })
  const a = await buildDemoSnapshot(deps, { trigger: 'cron', cursor: 0, maxEntriesPerRun: 3 })
  eq([a.status, a.written, a.cursor], ['partial', 3, 3])
  const all = await runAll(deps, { trigger: 'cron', maxEntriesPerRun: 3 })
  eq(all.status, 'complete')
})

Deno.test('scrub drops personal keys, redacts addresses, and refuses owner-bearing rows', async () => {
  eq(scrubBody({ name: 'Fund', email: 'a@b.co', nested: [{ full_name: 'X', note: 'write to ops@issuer.example.com' }] }),
    { name: 'Fund', nested: [{ note: 'write to [redacted]' }] })
  assertThrows(() => scrubBody({ rows: [{ user_id: 'u1', title: 'my watchlist' }] }), PersonalDataError)
  eq(scrubBody({ user_id: null, org_id: '' }), { user_id: null, org_id: '' })
  const db = fakeDb(), storage = memoryStorage()
  const result = await runAll({
    db, storage, env, now: () => NOW, planner: async () => requests(2),
    research: async (_c, p) => (Number(p.rwa_id) === 2 ? { data: { rows: [{ org_id: 'someone' }] } } : { data: { rows: [{ contact: 'x@y.io', avatar_url: 'u' }] } }),
  }, { trigger: 'cron' })
  eq(result.written, 1)
  eq(result.failed, 1)
  const stored = [...storage.files.entries()].find(([p]) => p.includes('/intel-research.'))![1]
  assert(!stored.includes('x@y.io') && !stored.includes('avatar_url'))
})

Deno.test('only the newest three snapshot dates are kept', async () => {
  const db = fakeDb(), storage = memoryStorage()
  for (const d of ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22']) await storage.upload(`snapshots/${d}/x.0000000000000000.json`, '{}')
  const result = await runAll({ db, storage, env, now: () => NOW, planner: async () => requests(1), research: async (_c, p) => researchBody(p) }, { trigger: 'cron' })
  eq(result.prunedDates.sort(), ['2026-09-19', '2026-09-20'])
  eq(await storage.list('snapshots'), ['2026-09-21', '2026-09-22', '2026-09-23'])
})

// ─── zero provider calls ─────────────────────────────────────────────────────

Deno.test('the research reader runs the shared-cache pass only and never reaches the network', async () => {
  const net = forbidNetwork()
  const saved = { key: Deno.env.get('COINMARKETCAP_API_KEY'), plan: Deno.env.get('CMC_VERIFIED_BASELINE_PLAN') }
  Deno.env.set('COINMARKETCAP_API_KEY', 'test-key-never-sent')
  Deno.env.set('CMC_VERIFIED_BASELINE_PLAN', 'professional')
  try {
    // Nothing cached: the read is left out, and no budget claim is made.
    const empty = fakeDb()
    eq(await cacheOnlyResearchReader(empty)('rwaInfo', { rwa_id: 5 }), null)
    assert(!empty.rpcs.some((r) => r.name === 'intel_free_rwa_read_claim'), 'the daily free budget is never claimed')
    assert(!empty.writes.some((w) => w.table === 'market_data_response_cache'), 'no demand stamp is written')

    // A cached row answers it, exactly as the free lane serves it.
    const later = new Date(Date.now() + 3_600_000).toISOString()
    const cached = fakeDb({ market_data_response_cache: [{
      provider: 'coinmarketcap', cache_key: 'any', response_json: { status: { timestamp: '2026-09-23T02:47:01.166Z', error_code: '0', credit_count: 1 }, data: [{ rwa_id: 5, name: 'Treasury fund' }] },
      expires_at: later, stale_until: later, fetched_at: new Date().toISOString(), observed_at: null, status_code: 200, error_kind: null, negative_cache: false,
    }] })
    // The cache key is derived from the API key hash; the fake answers any key.
    cached.tables.market_data_response_cache[0].cache_key = undefined
    const originalFrom = cached.from
    cached.from = (table: string) => {
      const q = originalFrom(table)
      if (table !== 'market_data_response_cache') return q
      const eqOriginal = q.eq
      q.eq = (k: string, v: unknown) => (k === 'cache_key' ? q : eqOriginal(k, v))
      return q
    }
    const body = await cacheOnlyResearchReader(cached)('rwaInfo', { rwa_id: 5 })
    assert(body, 'a cached shared record is served')
    eq(body!.freeShared, { lane: 'rwa_research', served: 'shared-cache' })
    eq(body!.refreshPolicy, { enabled: false, cacheReadSeconds: null, providerRefreshSeconds: null })
    // The snapshot carries the receipt's proof: the stored response's own charge
    // and a trimmed excerpt, and scrubbing keeps it (it holds no personal field).
    const receipt = (body as any).receipt
    eq(receipt.origin, 'cache')
    eq(receipt.creditCount, null)
    eq(receipt.proof.creditCount, 1)
    eq(receipt.proof.excerpt.status, { timestamp: '2026-09-23T02:47:01.166Z', error_code: '0', credit_count: 1 })
    eq((scrubBody(body) as any).receipt.proof, receipt.proof)
    assert(!JSON.stringify(body).includes('test-key-never-sent'), 'the key never rides in a snapshot body')
    // A capability outside the free RWA lane and the two shared market reads
    // (global, listings) is never read at all; those two use the same cache pass.
    eq(await cacheOnlyResearchReader(cached)('quotes', { id: '1' }), null)
    await cacheOnlyResearchReader(cached)('listings', { start: 1, limit: 25 })
    eq(net.calls, [], 'no network call of any kind')
  } finally {
    net.restore()
    if (saved.key == null) Deno.env.delete('COINMARKETCAP_API_KEY'); else Deno.env.set('COINMARKETCAP_API_KEY', saved.key)
    if (saved.plan == null) Deno.env.delete('CMC_VERIFIED_BASELINE_PLAN'); else Deno.env.set('CMC_VERIFIED_BASELINE_PLAN', saved.plan)
  }
})

Deno.test('a whole build over capture views makes no network call', async () => {
  const net = forbidNetwork()
  try {
    const db = fakeDb({ intel_rwa_universe_snapshots: universeRows }), storage = memoryStorage()
    const result = await runAll({ db, storage, env, now: () => NOW, planner: async (d, now) => planDemoRequests(d, now) }, { trigger: 'cron' })
    eq(result.status, 'complete')
    assert(result.written > 30, `wrote ${result.written}`)
    eq(net.calls, [])
  } finally { net.restore() }
})

Deno.test('a forced rebuild keeps handing on after an earlier run finished the same day', async () => {
  const db = fakeDb(), storage = memoryStorage()
  const deps = { db, storage, env, now: () => NOW, planner: async () => requests(4), research: async (_c: string, p: Record<string, unknown>) => researchBody(p) }
  // Earlier today: complete. Newest: the forced rebuild's planning run, partial at cursor 0.
  db.tables.intel_demo_snapshot_runs = [
    { id: 2, snapshot_date: '2026-09-23', latest_written: false, status: 'partial', resume_cursor: 0 },
    { id: 1, snapshot_date: '2026-09-23', latest_written: true, status: 'complete', resume_cursor: null },
  ]
  await storage.upload('snapshots/2026-09-23/_plan.json', JSON.stringify({ version: DEMO_SNAPSHOT_KEY_VERSION, date: '2026-09-23', createdAt: new Date(NOW).toISOString(), requests: requests(4).map((r) => ({ ...r, key: demoSnapshotKey(r.fn, r.body) })) }))
  const next = await buildDemoSnapshot(deps, { trigger: 'cron', cursor: 0 })
  eq(next.status, 'complete')
  eq(next.written, 4)
})
