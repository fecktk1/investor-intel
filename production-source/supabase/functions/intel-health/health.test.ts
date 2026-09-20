import { assert, assertEquals } from 'https://deno.land/std@0.208.0/assert/mod.ts'
import {
  ACCOUNT_SYNC_CURRENT_SECONDS, HEALTH_CACHE_CONTROL, HEALTH_LANES, SLACK_SECONDS, createHealthHandler, deriveHealth,
  laneState, collectHealth, type HealthInput, type LaneRead, type LaneSpec,
} from './health.ts'

const NOW = Date.parse('2026-09-16T21:00:00Z')
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()
const hourly: LaneSpec = { lane: 'regime', table: 't', column: 'captured_at', policyProvider: 'coinmarketcap', policyFeature: 'regime', scheduleSeconds: 3600, required: true }
const optional: LaneSpec = { ...hourly, lane: 'meme_stages', policyFeature: 'meme_stages', required: false }

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    now: NOW,
    specs: [hourly, optional],
    lanes: [{ lane: 'regime', ok: true, latestAt: iso(60) }, { lane: 'meme_stages', ok: true, latestAt: null }],
    policy: { ok: true, rows: [{ provider: 'coinmarketcap', feature: 'regime', cadence_seconds: 3600, enabled: true }] },
    account: { ok: true, verifiedAt: iso(120), observedAt: iso(120) },
    ...overrides,
  }
}

Deno.test('a fresh required lane and a current account sync are ok; an optional lane that never ran does not degrade', () => {
  const report = deriveHealth(input())
  assertEquals(report.status, 'ok')
  assertEquals(report.lanes.map((l) => l.state), ['ok', 'never'])
  assertEquals(report.counts.ok, 1)
  assertEquals(report.counts.never, 1)
  assertEquals(report.account.syncCurrent, true)
  assertEquals(report.reasons, [])
})

Deno.test('lane age bands: ok up to 1.5 cadences plus slack, late up to 3, stale beyond', () => {
  const read = (age: number): LaneRead => ({ lane: 'regime', ok: true, latestAt: iso(age) })
  const at = (age: number) => laneState(hourly, read(age), undefined, NOW).state
  assertEquals(at(3600 * 1.5 + SLACK_SECONDS), 'ok')
  assertEquals(at(3600 * 1.5 + SLACK_SECONDS + 1), 'late')
  assertEquals(at(3600 * 3 + SLACK_SECONDS), 'late')
  assertEquals(at(3600 * 3 + SLACK_SECONDS + 1), 'stale')
})

Deno.test('expected cadence is the slower of the cron schedule and the policy cadence', () => {
  const read: LaneRead = { lane: 'regime', ok: true, latestAt: iso(10) }
  assertEquals(laneState(hourly, read, { provider: 'coinmarketcap', feature: 'regime', cadence_seconds: 300 }, NOW).expectedCadenceSeconds, 3600)
  assertEquals(laneState(hourly, read, { provider: 'coinmarketcap', feature: 'regime', cadence_seconds: 7200 }, NOW).expectedCadenceSeconds, 7200)
  assertEquals(laneState(hourly, read, undefined, NOW).expectedCadenceSeconds, 3600)
})

Deno.test('a stale or unreadable required lane degrades; a paused lane does not', () => {
  const stale = deriveHealth(input({ lanes: [{ lane: 'regime', ok: true, latestAt: iso(86400) }] }))
  assertEquals(stale.status, 'degraded')
  assertEquals(stale.reasons, ['lane_stale:regime'])
  const unreadable = deriveHealth(input({ lanes: [{ lane: 'regime', ok: false, latestAt: null }, { lane: 'meme_stages', ok: true, latestAt: null }] }))
  assertEquals(unreadable.status, 'degraded')
  assertEquals(unreadable.lanes[0].state, 'unknown')
  const paused = deriveHealth(input({
    lanes: [{ lane: 'regime', ok: true, latestAt: iso(86400) }],
    policy: { ok: true, rows: [{ provider: 'coinmarketcap', feature: 'regime', cadence_seconds: 3600, enabled: false }] },
  }))
  assertEquals(paused.lanes[0].state, 'paused')
  assertEquals(paused.status, 'ok')
})

Deno.test('an account sync older than the current window degrades', () => {
  const report = deriveHealth(input({ account: { ok: true, verifiedAt: iso(ACCOUNT_SYNC_CURRENT_SECONDS + 1), observedAt: null } }))
  assertEquals(report.status, 'degraded')
  assertEquals(report.account.syncCurrent, false)
  assertEquals(report.account.lastObservationAgeSeconds, null)
  assertEquals(report.reasons, ['account_sync_not_current'])
})

Deno.test('no successful read at all is down; one successful empty read is reachable', () => {
  const down = deriveHealth(input({ lanes: [], policy: { ok: false, rows: [] }, account: { ok: false, verifiedAt: null, observedAt: null } }))
  assertEquals(down.status, 'down')
  assertEquals(down.database.reachable, false)
  assertEquals(down.reasons, ['database_unreachable'])
  const reachable = deriveHealth(input({ lanes: [{ lane: 'meme_stages', ok: true, latestAt: null }], policy: { ok: false, rows: [] }, account: { ok: false, verifiedAt: null, observedAt: null } }))
  assertEquals(reachable.database.reachable, true)
  assertEquals(reachable.status, 'degraded')
})

Deno.test('every registered lane names a distinct lane, a table and a positive schedule', () => {
  assertEquals(new Set(HEALTH_LANES.map((l) => l.lane)).size, HEALTH_LANES.length)
  for (const spec of HEALTH_LANES) {
    assert(/^[a-z_]+$/.test(spec.table) && /^[a-z_]+$/.test(spec.column), spec.lane)
    assert(spec.scheduleSeconds > 0, spec.lane)
  }
})

Deno.test('a table more than one lane writes is read through a filter, so one lane cannot report the other as fresh', () => {
  const shared = new Map<string, LaneSpec[]>()
  for (const spec of HEALTH_LANES) shared.set(spec.table, [...(shared.get(spec.table) ?? []), spec])
  for (const [table, specs] of shared) {
    if (specs.length < 2) continue
    for (const spec of specs) assert(spec.filter, `${spec.lane} shares ${table} but reads it unfiltered`)
    assertEquals(new Set(specs.map((s) => s.filter)).size, specs.length, `${table} lanes share a filter`)
  }
  // The two meme-graduation lanes are the case this rule exists for.
  const meme = HEALTH_LANES.find((l) => l.lane === 'meme_stages')!
  const launchpads = HEALTH_LANES.find((l) => l.lane === 'launchpad_stages')!
  assertEquals(meme.table, launchpads.table)
  const sunpump = HEALTH_LANES.find((l) => l.lane === 'sunpump_stages')!
  assertEquals(meme.filter, 'source=eq.coinmarketcap')
  assertEquals(launchpads.filter, 'source=eq.coingecko')
  assertEquals(sunpump.table, meme.table)
  assertEquals(sunpump.filter, 'source=eq.trongrid')
  assertEquals(launchpads.policyProvider, 'coingecko')
  assertEquals(launchpads.policyFeature, 'launchpad_stages')
  assertEquals(sunpump.policyProvider, 'trongrid')
  assertEquals(sunpump.policyFeature, 'sunpump_stages')
  // New, and their key tiers are not yet proven in production: neither must be
  // able to turn the public route amber on its own.
  assertEquals(launchpads.required, false)
  assertEquals(sunpump.required, false)
})

Deno.test('a lane filter reaches the PostgREST query', async () => {
  const rest = fakeRest()
  await collectHealth({ supabaseUrl: 'https://db.test', serviceKey: 'k', fetcher: rest.fetcher, now: () => NOW },
    [HEALTH_LANES.find((l) => l.lane === 'launchpad_stages')!])
  assert(rest.urls.some((url) => url.includes('source=eq.coingecko')), rest.urls.join(' | '))
})

// A fake PostgREST that answers what the handler selects and records every URL.
function fakeRest(options: { fail?: boolean; rejectNegativeIndex?: boolean } = {}) {
  const urls: string[] = []
  const fetcher = (url: string) => {
    urls.push(url)
    if (options.fail) return Promise.resolve(new Response('no', { status: 500 }))
    const path = new URL(url).pathname.split('/').pop()!
    const query = new URL(url).searchParams
    let body: unknown = []
    if (path === 'provider_schedule_policy') body = [{ provider: 'coinmarketcap', feature: 'regime', cadence_seconds: 3600, enabled: true }]
    else if (path === 'provider_quota_budgets') {
      if (options.rejectNegativeIndex && query.get('select')!.includes('->-1')) return Promise.resolve(new Response('{}', { status: 400 }))
      body = [{ data_type: 'cmc_account', verified_at: iso(60) }, { data_type: 'cmc_account_observation', observed_at: iso(60), updated_at: iso(90) }]
    } else {
      const column = query.get('select')!
      body = [{ [column]: iso(30) }]
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
  return { urls, fetcher }
}

Deno.test('GET answers with public cache headers, CORS and no commercial fields', async () => {
  const rest = fakeRest()
  const handler = createHealthHandler({ supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetcher: rest.fetcher, now: () => NOW })
  const response = await handler(new Request('https://x/functions/v1/intel-health'))
  assertEquals(response.status, 200)
  assertEquals(response.headers.get('Cache-Control'), HEALTH_CACHE_CONTROL)
  assertEquals(response.headers.get('Access-Control-Allow-Origin'), '*')
  const text = await response.text()
  const report = JSON.parse(text)
  assertEquals(report.status, 'ok')
  assertEquals(report.lanes.length, HEALTH_LANES.length)
  // Only clocks leave the database: no selected column is a credit, plan, limit,
  // key, fingerprint or payload, and nothing of the kind is in the body.
  for (const url of rest.urls) {
    const select = new URL(url).searchParams.get('select') ?? ''
    assert(!/credit|limit|used|plan|reset|fingerprint|response_json|max_credits|min_plan|\*/.test(select), select)
  }
  assert(!/credit|plan|limit|fingerprint|reset|reservation|key/i.test(text), 'commercial or credential vocabulary in the body')
})

Deno.test('the observation clock falls back to the row clock when the JSON index is refused', async () => {
  const rest = fakeRest({ rejectNegativeIndex: true })
  const handler = createHealthHandler({ supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetcher: rest.fetcher, now: () => NOW })
  const report = await (await handler(new Request('https://x/'))).json()
  assertEquals(report.account.lastObservationAgeSeconds, 90)
  assertEquals(report.account.syncCurrent, true)
})

Deno.test('methods other than GET are refused, OPTIONS is a preflight, failed reads are down with 503', async () => {
  const rest = fakeRest({ fail: true })
  let clock = NOW
  const handler = createHealthHandler({ supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetcher: rest.fetcher, now: () => clock })
  assertEquals((await handler(new Request('https://x/', { method: 'POST' }))).status, 405)
  const preflight = await handler(new Request('https://x/', { method: 'OPTIONS' }))
  assertEquals(preflight.status, 204)
  assertEquals(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, OPTIONS')
  const down = await handler(new Request('https://x/'))
  assertEquals(down.status, 503)
  assertEquals((await down.json()).status, 'down')
  // A second request inside the memo window does not touch the database again.
  const before = rest.urls.length
  clock += 30_000
  await (await handler(new Request('https://x/'))).body?.cancel()
  assertEquals(rest.urls.length, before)
})

Deno.test('a function with no service configuration reports down instead of throwing', async () => {
  const response = await createHealthHandler(null)(new Request('https://x/'))
  assertEquals(response.status, 503)
  assertEquals((await response.json()).database.reachable, false)
})
