import { assertEquals as eq, assert, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  captureRwaCoverage, lanePolicy, RWA_COVERAGE_OPS, RWA_COVERAGE_CAPTURE_SCHEDULE, RWA_COVERAGE_CREDIT_CEILING,
  COVERAGE_BATCH, COVERAGE_ASSET_TABLE, COVERAGE_TOKEN_TABLE, COVERAGE_CHANGE_TABLE,
} from './capture-rwa-coverage.ts'
import { MAP_TABLE, MAP_COUNT_TABLE } from './capture-rwa-underlyings.ts'
import { fakeDb, fakeRequest, ctxFor, quoteRow, token, mapRow } from './capture-rwa-coverage.fixtures.ts'

const NOW = new Date('2026-09-22T03:19:00.000Z')
const TODAY = '2026-09-22'
const MAP_RUN = '2026-09-22T03:11:01.742Z'
const MIGRATION = new URL('../../../migrations/20260922110000_intel_rwa_universe_coverage.sql', import.meta.url)
const sql = await Deno.readTextFile(MIGRATION)

/** A quotes response for the ids asked: asset N gets a token whose state
 * depends on N mod 4, and every id divisible by 10 is left out of the response. */
// deno-lint-ignore no-explicit-any
function quotesFor(params: Record<string, unknown>): any {
  const ids = String(params.rwa_id).split(',').map(Number)
  const rows = ids.filter((id) => id % 10 !== 0).map((id) => {
    const kind = id % 4
    const tokens = kind === 0 ? [] // no tokens reported
      : kind === 1 ? [token(id * 100 + 1, `T${id}`, `Token ${id}`, `iss${id % 3}`, 10, 1000, 500)] // tradeable
      : kind === 2 ? [token(id * 100 + 1, `T${id}`, `Token ${id}`, null, 10, 1000, 0)] // priced_not_traded
      : [token(id * 100 + 1, `T${id}`, `Token ${id}`, 'x', null, null, null), token(id * 100 + 2, `U${id}`, `Token ${id}b`, 'x', 5, 10, null)]
    return quoteRow(id, `S${id}`, 'stock', tokens)
  })
  return { payload: { data: { rwa_assets: rows }, status: { timestamp: '2026-09-22T03:19:00Z' } } }
}

const mapRows = (n: number, seen = MAP_RUN) => Array.from({ length: n }, (_, i) => mapRow(i + 1, seen))

Deno.test('schedule constant matches the migration, which authenticates from vault like its siblings', () => {
  const m = sql.match(/SELECT cron\.schedule\('([^']+)', '([^']+)', \$\$([\s\S]*?)\$\$\);/)
  assert(m)
  eq(m[1], RWA_COVERAGE_CAPTURE_SCHEDULE.rwa_coverage.job)
  eq(m[2], RWA_COVERAGE_CAPTURE_SCHEDULE.rwa_coverage.cron)
  assertMatch(m[3], /jsonb_build_object\('op','rwa_coverage'\)/)
  for (const secret of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET']) {
    assert(m[3].includes(`(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '${secret}')`))
  }
  assert(sql.includes(`SELECT cron.unschedule('${m[1]}') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${m[1]}');`))
  assertMatch(m[3], /timeout_milliseconds := 110000/)
  // After the 03:11 rwaMap job, which it reads.
  assert(Number(m[2].split(' ')[0]) > 11 && m[2].split(' ')[1] === '3')
})

Deno.test('policy row and retention: max_credits matches the lane, retention 400d/180d, changes append-only', () => {
  assertMatch(sql, new RegExp(`\\('coinmarketcap', 'rwa_coverage', 86400, true, NULL, ${RWA_COVERAGE_CREDIT_CEILING},`))
  assertMatch(sql, /intel_rwa_coverage_tokens WHERE snapshot_date < \(p_now - interval ''180 days''\)::date/)
  assertMatch(sql, /intel_rwa_coverage_assets WHERE snapshot_date < \(p_now - interval ''400 days''\)::date/)
  assert(!/DELETE FROM public\.intel_rwa_coverage_changes/.test(sql))
  assertMatch(sql, /GRANT SELECT, INSERT ON TABLE public\.intel_rwa_coverage_changes TO service_role;/)
  assertMatch(sql, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public\.intel_rwa_coverage_changes FROM service_role;/)
  for (const t of ['intel_rwa_coverage_assets', 'intel_rwa_coverage_tokens', 'intel_rwa_coverage_changes']) {
    assert(sql.includes(`CREATE TABLE IF NOT EXISTS public.${t}`))
    assert(sql.includes(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`))
    assert(sql.includes(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated;`))
  }
})

Deno.test('lane policy: missing row falls back to daily and the documented ceiling; row max_credits wins', () => {
  eq(lanePolicy({ request: async () => null }), { enabled: true, cadenceSeconds: 86400, maxCredits: RWA_COVERAGE_CREDIT_CEILING })
  eq(lanePolicy({ request: async () => null, policy: [{ provider: 'coinmarketcap', feature: 'rwa_coverage', cadence_seconds: 86400, enabled: true, max_credits: 3 }] }).maxCredits, 3)
})

Deno.test('disabled policy and within-cadence both skip without a provider call', async () => {
  const fake = fakeRequest(() => null)
  const off = await captureRwaCoverage(fakeDb({ [MAP_TABLE]: mapRows(3) }), ctxFor, NOW, { request: fake.request, policy: [{ provider: 'coinmarketcap', feature: 'rwa_coverage', enabled: false }] })
  eq(off.skipped, 'policy_disabled')
  const recent = fakeDb({ [MAP_TABLE]: mapRows(3), [COVERAGE_ASSET_TABLE]: [{ snapshot_date: TODAY, captured_at: '2026-09-22T01:00:00.000Z', rwa_id: '1' }] })
  const within = await captureRwaCoverage(recent, ctxFor, NOW, { request: fake.request })
  eq(within.skipped, 'within_cadence')
  eq(fake.calls.length, 0)
})

Deno.test('first run: batches of 100, one credit each, states classified, failed batch not_returned, no events', async () => {
  const db = fakeDb({
    // 250 fresh ids, one stale id and one known to lack tokens: neither is asked about.
    [MAP_TABLE]: [...mapRows(250), mapRow(900, '2026-09-19T03:11:00.000Z'), mapRow(901, MAP_RUN, { has_tokens: false })],
  })
  const fake = fakeRequest((name, params, index) => (index === 1 ? { payload: null, reason: 'http_500' } : quotesFor(params)))
  const result = await captureRwaCoverage(db, ctxFor, NOW, { request: fake.request })
  eq(fake.calls.map((c) => c.name), ['rwaQuotes', 'rwaQuotes', 'rwaQuotes'])
  eq(fake.calls.map((c) => String(c.params.rwa_id).split(',').length), [100, 100, 50])
  assert(!String(fake.calls.map((c) => c.params.rwa_id)).split(',').includes('900'))
  assert(!String(fake.calls.map((c) => c.params.rwa_id)).split(',').includes('901'))
  eq(result.credits, 3)
  eq(result.calls, 3)
  eq(result.error, undefined)
  eq(result.partial, 'batches_failed:1')

  const assets = db.upserts[COVERAGE_ASSET_TABLE]
  eq(assets.length, 250)
  const byId = new Map(assets.map((a) => [a.rwa_id, a]))
  eq(byId.get('1').coverage_state, 'tradeable')
  eq(byId.get('2').coverage_state, 'priced_not_traded')
  eq(byId.get('3').coverage_state, 'priced_not_traded') // listed_only + priced token -> best is priced_not_traded
  eq([byId.get('3').token_count, byId.get('3').priced_count, byId.get('3').traded_count], [2, 1, 0])
  eq(byId.get('4').coverage_state, 'no_tokens_reported')
  eq(byId.get('4').token_count, 0)
  eq(byId.get('20').coverage_state, 'not_returned') // left out of the response
  eq(byId.get('20').not_returned_reason, 'not_in_response')
  eq(byId.get('150').coverage_state, 'not_returned') // failed batch
  eq(byId.get('150').not_returned_reason, 'batch_failed:http_500')
  eq(byId.get('150').token_count, null)
  for (const a of assets) eq(a.snapshot_date, TODAY)

  const tokens = db.upserts[COVERAGE_TOKEN_TABLE]
  const t3 = tokens.filter((t) => t.rwa_id === '3').map((t) => t.token_state).sort()
  eq(t3, ['listed_only', 'priced_not_traded'])
  // No events on the first snapshot, and no write to the event table at all.
  eq(db.upserts[COVERAGE_CHANGE_TABLE], undefined)
  eq(result.changes, 0)
})

Deno.test('the credit ceiling binds: ids beyond it are stored as not_returned credit_ceiling', async () => {
  const db = fakeDb({ [MAP_TABLE]: mapRows(250) })
  const fake = fakeRequest((_n, params) => quotesFor(params))
  const result = await captureRwaCoverage(db, ctxFor, NOW, {
    request: fake.request, policy: [{ provider: 'coinmarketcap', feature: 'rwa_coverage', cadence_seconds: 86400, enabled: true, max_credits: 2 }],
  })
  eq(fake.calls.length, 2)
  eq(result.credits, 2)
  eq(result.partial, 'credit_ceiling')
  const tail = db.upserts[COVERAGE_ASSET_TABLE].filter((a) => Number(a.rwa_id) > 200)
  eq(tail.length, 50)
  assert(tail.every((a) => a.coverage_state === 'not_returned' && a.not_returned_reason === 'credit_ceiling'))
})

Deno.test('every batch failing is an error with no write', async () => {
  const db = fakeDb({ [MAP_TABLE]: mapRows(5) })
  const result = await captureRwaCoverage(db, ctxFor, NOW, { request: fakeRequest(() => ({ payload: null, reason: 'http_429' })).request })
  assertMatch(String(result.error), /all_batches_failed/)
  eq(db.upserts[COVERAGE_ASSET_TABLE], undefined)
})

const YESTERDAY = '2026-09-21'
const prevAsset = (rwaId: number, state: string) => ({ provider: 'coinmarketcap', snapshot_date: YESTERDAY, rwa_id: String(rwaId), coverage_state: state, symbol: `S${rwaId}`, name: null, asset_type: 'stock', captured_at: '2026-09-21T03:19:00.000Z' })

function secondDay(countTruncated: boolean | null) {
  return fakeDb({
    [MAP_TABLE]: [...mapRows(9), mapRow(50, '2026-09-21T03:11:00.000Z') /* stale: not asked, candidate for removal */],
    [COVERAGE_ASSET_TABLE]: [
      prevAsset(1, 'priced_not_traded'), // today tradeable -> became_tradeable
      prevAsset(2, 'tradeable'),         // today priced_not_traded -> shelved
      prevAsset(5, 'tradeable'),         // today tradeable -> nothing
      prevAsset(50, 'tradeable'),        // gone from map -> removed (only if count row complete)
      prevAsset(51, 'not_returned'),     // gone, but was not answered -> nothing
    ],
    [MAP_COUNT_TABLE]: countTruncated == null ? [] : [{ asset_type: 'all', snapshot_date: TODAY, truncated: countTruncated, captured_at: MAP_RUN }],
  })
}

Deno.test('second day: listed, became_tradeable, shelved and removed are written INSERT-only', async () => {
  const db = secondDay(false)
  const result = await captureRwaCoverage(db, ctxFor, NOW, { request: fakeRequest((_n, p) => quotesFor(p)).request })
  const events = db.upserts[COVERAGE_CHANGE_TABLE].map((e) => `${e.rwa_id}:${e.change_kind}`).sort()
  eq(events, ['1:became_tradeable', '2:shelved', '3:listed', '4:listed', '50:removed', '6:listed', '7:listed', '8:listed', '9:listed'])
  eq(db.upsertOptions[COVERAGE_CHANGE_TABLE][0], { onConflict: 'provider,snapshot_date,rwa_id,change_kind', ignoreDuplicates: true })
  for (const e of db.upserts[COVERAGE_CHANGE_TABLE]) { eq(e.previous_snapshot_date, YESTERDAY); eq(e.snapshot_date, TODAY) }
  eq(result.previousSnapshotDate, YESTERDAY)
})

Deno.test('removed is withheld when today\'s map count is truncated or missing', async () => {
  for (const truncated of [true, null]) {
    const db = secondDay(truncated)
    await captureRwaCoverage(db, ctxFor, NOW, { request: fakeRequest((_n, p) => quotesFor(p)).request })
    const kinds = db.upserts[COVERAGE_CHANGE_TABLE].map((e) => e.change_kind)
    assert(!kinds.includes('removed'), `removed emitted with truncated=${truncated}`)
    // Without a complete map run the 36-hour window keeps yesterday's asset in.
    assert(db.upserts[COVERAGE_ASSET_TABLE].some((a) => a.rwa_id === '50'))
  }
})

Deno.test('RWA_COVERAGE_OPS exposes exactly the rwa_coverage op', () => {
  eq(Object.keys(RWA_COVERAGE_OPS), ['rwa_coverage'])
  eq(COVERAGE_BATCH, 100)
})
