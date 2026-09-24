import assert from 'node:assert/strict'
import { requestCmc } from './cmc-transport.ts'

// Why the RWA wrapper capture passes `waitForFresh`.
//
// A key past its one-hour window but inside its six-hour stale window is answered
// from the OLD copy while the live refresh runs in the background (EdgeRuntime
// waitUntil). A scheduled capture that lands there stores the old copy under a new
// capture hour and never sees the call it paid for. The six-hourly wrapper cron
// lands within a second of that boundary, so from 2026-09-20 to 2026-09-23 about
// half its runs stored the previous run's prices.

function fakeDb(cache: Record<string, unknown>) {
  // deno-lint-ignore no-explicit-any
  const state = { cache: { ...cache } as any, rpcs: [] as string[] }
  return {
    state,
    // deno-lint-ignore no-explicit-any
    rpc: (name: string, _args: any) => {
      state.rpcs.push(name)
      return Promise.resolve({ data: name === 'cmc_account_sync_claim' ? { allowed: false, reason: 'account_fresh' } : name === 'cmc_request_reserve' ? { allowed: true, reservation_id: 'test-reservation' } : true })
    },
    from: (table: string) => {
      // deno-lint-ignore no-explicit-any
      let patch: any = null
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q, eq: () => q,
        upsert: () => Promise.resolve({ error: null }),
        maybeSingle: () => Promise.resolve({ data: table === 'market_data_response_cache' ? state.cache : null }),
        // deno-lint-ignore no-explicit-any
        update: (v: any) => { patch = v; return q },
        insert: () => Promise.resolve({ error: null }),
        // deno-lint-ignore no-explicit-any
        then: (resolve: any) => { if (table === 'market_data_response_cache' && patch) state.cache = { ...state.cache, ...patch }; resolve({ error: null }) },
      }
      return q
    },
  }
}

async function withEnvironment(fn: () => Promise<void>) {
  const names = ['COINMARKETCAP_API_KEY', 'CMC_API_KEY', 'CMC_ENABLED', 'CMC_VERIFIED_BASELINE_PLAN', 'CMC_ACCESS_PROFILE', 'CMC_VERIFIED_HACKATHON_PLAN', 'CMC_HACKATHON_EXPIRES_AT', 'CMC_CONNECTED_DEMAND_ENABLED']
  const saved = names.map((n) => Deno.env.get(n)), originalFetch = globalThis.fetch
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any, originalRuntime = g.EdgeRuntime
  Deno.env.set(names[0], 'synthetic-cmc-test-key'); Deno.env.set('CMC_ENABLED', 'true'); Deno.env.set('CMC_VERIFIED_BASELINE_PLAN', 'basic')
  Deno.env.delete('CMC_ACCESS_PROFILE'); Deno.env.delete('CMC_HACKATHON_EXPIRES_AT'); Deno.env.delete('CMC_CONNECTED_DEMAND_ENABLED')
  try { await fn() } finally {
    globalThis.fetch = originalFetch
    if (originalRuntime === undefined) delete g.EdgeRuntime; else g.EdgeRuntime = originalRuntime
    names.forEach((n, i) => saved[i] == null ? Deno.env.delete(n) : Deno.env.set(n, saved[i]!))
  }
}

const quotesBody = (lastUpdated: string) => ({
  status: { timestamp: new Date().toISOString(), error_code: 0, credit_count: 1 },
  data: { rwa_assets: [{ rwa_id: 1, symbol: 'GOLD', quotes: [{ symbol: 'USD', crypto_id: 2781, last_updated: lastUpdated, average_tokenized_price: 4283 }], tokens: [] }] },
})

/** The previous run's copy, six hours old less a second: past its one-hour
 * window, one second inside its six-hour stale window. */
const staleCopy = () => ({
  response_json: quotesBody('2026-09-23T08:45:59.000Z'), status_code: 200,
  fetched_at: new Date(Date.now() - 21_599_000).toISOString(),
  expires_at: new Date(Date.now() - 17_999_000).toISOString(),
  stale_until: new Date(Date.now() + 1_000).toISOString(),
})

const lastUpdated = (result: { payload: unknown }) =>
  // deno-lint-ignore no-explicit-any
  (result.payload as any)?.data?.rwa_assets?.[0]?.quotes?.[0]?.last_updated

Deno.test('a capture without waitForFresh is handed the stale copy while its paid refresh goes only to the cache', () => withEnvironment(async () => {
  let fetched = 0
  globalThis.fetch = () => { fetched += 1; return Promise.resolve(Response.json(quotesBody('2026-09-23T14:45:59.000Z'))) }
  // deno-lint-ignore no-explicit-any
  const background: Promise<any>[] = []
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<any>) => { background.push(p) } }
  const db = fakeDb(staleCopy())
  const result = await requestCmc('rwaQuotes', { rwa_id: '1' }, { supabase: db, kind: 'job', maxCalls: 1, caller: 'intel-capture-rwa-wrappers' })
  await Promise.all(background)
  assert.equal(result.state, 'stale')
  assert.equal(lastUpdated(result), '2026-09-23T08:45:59.000Z')
  // The live call WAS made and its answer landed in the cache, not in the capture.
  assert.equal(fetched, 1)
  assert.equal(db.state.cache.response_json.data.rwa_assets[0].quotes[0].last_updated, '2026-09-23T14:45:59.000Z')
}))

Deno.test('the same capture with waitForFresh stores the answer of the call it pays for', () => withEnvironment(async () => {
  let fetched = 0
  globalThis.fetch = () => { fetched += 1; return Promise.resolve(Response.json(quotesBody('2026-09-23T14:45:59.000Z'))) }
  // deno-lint-ignore no-explicit-any
  ;(globalThis as any).EdgeRuntime = { waitUntil: () => { throw new Error('a capture waiting for fresh data must not refresh in the background') } }
  const db = fakeDb(staleCopy())
  const result = await requestCmc('rwaQuotes', { rwa_id: '1' }, { supabase: db, kind: 'job', maxCalls: 1, caller: 'intel-capture-rwa-wrappers', waitForFresh: true })
  assert.equal(result.state, 'fresh')
  assert.equal(lastUpdated(result), '2026-09-23T14:45:59.000Z')
  // One call either way: waiting spends nothing the background refresh did not.
  assert.equal(fetched, 1)
}))
