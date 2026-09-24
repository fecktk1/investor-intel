import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDemoFetch, DEMO_MISS_CODE, demoAccountAccess, demoScreenFor, demoViewFor, researchCopyPastWindow } from '../../demo/demo-fetch'
import { createDemoStore } from '../../demo/demo-store'
import { createSnapshotReader, publicObjectUrl } from '../../demo/demo-snapshot'
import { DEMO_ORG_ID, DEMO_USER_ID } from '../../demo/demo-identity'
import { readCaptureView, captureReasonText } from '../capture-api'
import { demoEntryPath, demoSnapshotKey } from '../../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'

const URL_BASE = 'https://demo-backend.supabase.co'
const translate = (key, o) => String(o?.defaultValue || key)
const RWA_COVERAGE = { view: 'rwa_coverage', asOf: '2026-09-23T03:19:00.000Z', coverage: { from: null, to: null, count: 791 }, reason: null, sourcePolicy: { exportAllowed: false } }
const RWA_LIST = { version: 1, capability: 'rwaList', state: 'cached', data: { rows: [{ rwa_id: 7, name: 'Tokenised Treasury' }], total: 1, hasMore: false }, freeShared: { lane: 'rwa_research', served: 'shared-cache' } }

// A public bucket holding one capture view and one research page, served by a
// fake network that fails the test on anything other than a public bucket GET.
function bucket(entries) {
  const date = '2026-09-23'
  const files = new Map()
  files.set(publicObjectUrl(URL_BASE, 'latest.json'), { date, capturedAt: '2026-09-23T04:13:00.000Z', version: 1, keys: Object.keys(entries) })
  for (const [key, body] of Object.entries(entries)) files.set(publicObjectUrl(URL_BASE, demoEntryPath(date, key)), { version: 1, key, status: 200, body })
  const calls = []
  const network = vi.fn(async (input, init) => {
    const href = String(input?.url ?? input)
    calls.push({ href, init })
    if (!href.startsWith(publicObjectUrl(URL_BASE, ''))) throw new Error(`live backend reached: ${href}`)
    const file = files.get(href)
    return file ? new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 404 })
  })
  return { network, calls }
}

function demoClient(entries = {}) {
  const net = bucket(entries)
  const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
  const store = createDemoStore()
  const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store })
  const client = createClient(URL_BASE, 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: demoFetch },
  })
  return { client, demoFetch, store, net }
}

const captureKey = (view, params = {}) => demoSnapshotKey('intel-capture', { ...params, op: 'read', view })

describe('demoFetch', () => {
  it('answers a snapshotted capture read with the stored body, through the real capture client', async () => {
    const { client, net } = demoClient({ [captureKey('rwa_coverage')]: RWA_COVERAGE })
    const read = await readCaptureView('rwa_coverage', {}, { orgId: DEMO_ORG_ID, supabase: client })
    expect(read).toEqual(RWA_COVERAGE)
    // Only public bucket objects were fetched, without credentials.
    for (const call of net.calls) {
      expect(call.href.startsWith(`${URL_BASE}/storage/v1/object/public/intel-demo/`)).toBe(true)
      expect(call.init.credentials).toBe('omit')
    }
  })

  it('answers a snapshotted research read (useMarketResearch request shape)', async () => {
    const key = demoSnapshotKey('intel-research', { capability: 'rwaList', params: { start: 1, limit: 25 } })
    const { client } = demoClient({ [key]: RWA_LIST })
    const { data, error } = await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'rwaList', params: { start: 1, limit: 25 } } })
    expect(error).toBeNull()
    expect(data).toEqual(RWA_LIST)
  })

  it('a miss is the demo reason, which the app renders as the sign-up sentence', async () => {
    const { client } = demoClient({})
    const failure = await readCaptureView('rwa_depth', {}, { orgId: DEMO_ORG_ID, supabase: client }).catch((e) => e)
    expect(failure.code).toBe(DEMO_MISS_CODE)
    expect(captureReasonText(translate, failure.code)).toBe("Not in today's demo snapshot. Create a free account to look it up.")
    const research = await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'rwaInfo', params: { rwa_id: 9 } } })
    expect(research.data.state).toBe('unavailable')
    expect(research.data.reason).toBe(DEMO_MISS_CODE)
    const generate = await client.functions.invoke('intel-generate', { body: { orgId: DEMO_ORG_ID, kind: 'brief' } })
    expect(generate.data.code).toBe(DEMO_MISS_CODE)
    expect(generate.data.error).toMatch(/Not in today's demo snapshot/)
  })

  it('writes land in memory, come back on the next read, and never leave the browser', async () => {
    const { client, net } = demoClient({})
    const { data: created, error } = await client.from('watchlists').insert({ org_id: DEMO_ORG_ID, name: 'My list', is_default: true }).select('*').single()
    expect(error).toBeNull()
    expect(created.name).toBe('My list')
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/)
    const { data: listed } = await client.from('watchlists').select('*').eq('org_id', DEMO_ORG_ID).order('is_default', { ascending: false })
    expect(listed.map((r) => r.name)).toEqual(['My list'])
    const { error: updateError } = await client.from('watchlists').update({ name: 'Renamed' }).eq('id', created.id)
    expect(updateError).toBeNull()
    expect((await client.from('watchlists').select('*').eq('id', created.id).maybeSingle()).data.name).toBe('Renamed')
    await client.from('watchlists').delete().eq('id', created.id)
    expect((await client.from('watchlists').select('*')).data).toEqual([])
    // A write RPC succeeds in memory; an unknown read RPC is the demo miss.
    const saved = await client.rpc('intel_save_workspace_preferences', { p_org_id: DEMO_ORG_ID, p_slot: 'desk', p_revision: 0, p_value: { layout: 'wide' } })
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ slot: 'desk', revision: 1, value: { layout: 'wide' } })
    const prefs = (await client.from('intel_workspace_preferences').select('*').eq('org_id', DEMO_ORG_ID).limit(4)).data
    expect(prefs.map((r) => [r.slot, r.revision])).toEqual([['desk', 1]])
    expect((await client.rpc('intel_save_workspace_preferences', { p_slot: 'desk', p_value: { layout: 'narrow' } })).data.revision).toBe(2)
    expect((await client.rpc('intel_current_regime')).error.code).toBe(DEMO_MISS_CODE)
    expect(net.calls.every((c) => c.href.includes('/storage/v1/object/public/intel-demo/'))).toBe(true)
  })

  it('tracking an item names it in memory, through the real watchlist calls, and the item reads back with its entity', async () => {
    const { client, net } = demoClient({})
    const { addWatchlistItem, listWatchlist, ResolveRefused } = await import('../watchlist-api')
    const item = await addWatchlistItem(client, DEMO_ORG_ID, DEMO_USER_ID, { chain: 'solana', value: 'So11111111111111111111111111111111111111112' })
    expect(item.entity).toMatchObject({ entity_kind: 'asset', canonical_ref_key: 'solana:mainnet/token:So11111111111111111111111111111111111111112' })
    const narrative = await addWatchlistItem(client, DEMO_ORG_ID, DEMO_USER_ID, { kind: 'narrative', value: 'AI agents', itemType: 'narrative' })
    expect(narrative.entity.canonical_ref_key).toBe('narrative:ai-agents')
    const listed = await listWatchlist(client, DEMO_ORG_ID)
    expect(listed.map((row) => row.entity?.canonical_ref_key).sort()).toEqual([narrative.entity.canonical_ref_key, item.entity.canonical_ref_key].sort())
    // Naming the same thing twice reuses the row, as the endpoint does.
    const again = await client.functions.invoke('intel-resolve', { body: { orgId: DEMO_ORG_ID, kind: 'narrative', value: 'AI agents' } })
    expect(again.data.entity.id).toBe(narrative.entity.id)
    // A malformed address is refused with the endpoint's machine code.
    const refused = await addWatchlistItem(client, DEMO_ORG_ID, DEMO_USER_ID, { chain: 'solana', value: '0x1234' }).catch((e) => e)
    expect(refused).toBeInstanceOf(ResolveRefused)
    expect(net.calls.every((c) => c.href.includes('/storage/v1/object/public/intel-demo/'))).toBe(true)
  })

  it('personal surfaces start empty and the visitor is synthetic', async () => {
    const { client } = demoClient({})
    for (const table of ['watchlists', 'investor_portfolios', 'intel_theses', 'intel_alert_rules', 'saved_research', 'intel_research_threads', 'intel_trades', 'intel_telegram_chats', 'support_tickets', 'intel_workspace_preferences']) {
      const { data, error } = await client.from(table).select('*').eq('org_id', DEMO_ORG_ID)
      expect(error).toBeNull()
      expect(data).toEqual([])
    }
    expect((await client.rpc('intel_list_briefs')).data).toEqual([])
    const profile = (await client.from('profiles').select('*').eq('id', DEMO_USER_ID).single()).data
    expect(profile.display_name).toBe('Demo visitor')
    expect(profile.email).toBeUndefined()
    const members = (await client.from('org_members').select('role, org:orgs(id,name,product_mode)').eq('user_id', DEMO_USER_ID)).data
    expect(members[0].org).toMatchObject({ id: DEMO_ORG_ID, name: 'Demo workspace', product_mode: 'intel' })
    expect((await client.rpc('get_my_org_id')).data).toBe(DEMO_ORG_ID)
    const access = (await client.rpc('intel_account_access', { p_org: DEMO_ORG_ID })).data
    expect(access).toEqual(demoAccountAccess())
    expect(access.tier).toBe('starter')
    expect(Object.values(access.surfaces).every((s) => s.allowed === true)).toBe(true)
    const user = await (await client.functions.invoke('help-assistant', { body: { action: 'status' } })).data
    expect(user).toEqual({ tutorials_enabled: false, assistant_enabled: false })
  })

  it('the book calendar starts empty in its own object shape, never as a failed read', async () => {
    const { client } = demoClient()
    const { loadBookCalendar } = await import('../book-calendar')
    const from = Date.parse('2026-09-23T00:00:00Z'), to = from + 72 * 3600_000
    const data = await loadBookCalendar(client, { orgId: DEMO_ORG_ID, from, to, knownAt: from })
    expect(data).toMatchObject({ rows: [], hasMore: false, page: 0, unmatchedUnlocks: 0, scope: 'book' })
  })

  it('auth answers the synthetic visitor and refuses everything else', async () => {
    const { demoFetch } = demoClient({})
    const me = await (await demoFetch(`${URL_BASE}/auth/v1/user`, { headers: { Authorization: 'Bearer intel-demo-visitor' } })).json()
    expect(me.id).toBe(DEMO_USER_ID)
    expect(me.email).toBe('')
    expect((await demoFetch(`${URL_BASE}/auth/v1/token?grant_type=password`, { method: 'POST', body: '{}' })).status).toBe(400)
    expect((await demoFetch(`${URL_BASE}/storage/v1/object/sign/uploads/x`, { method: 'POST' })).status).toBe(404)
  })
})

describe('the network seam when the demo is off', () => {
  beforeEach(() => { vi.resetModules() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('passes every request through to the global fetch, and the authenticated client still sets its token', async () => {
    const seen = []
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      seen.push({ href: String(input?.url ?? input), auth: new Headers(init?.headers || {}).get('Authorization') })
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const mod = await import('../../../lib/supabase')
    await mod.supabase.from('platform_verticals').select('*')
    const authed = mod.createAuthenticatedClient('member-token')
    await authed.from('watchlists').select('*')
    expect(seen).toHaveLength(2)
    expect(seen[0].href).toContain('/rest/v1/platform_verticals')
    expect(seen[1].href).toContain('/rest/v1/watchlists')
    expect(seen[1].auth).toBe('Bearer member-token')
  })

  it('setSupabaseFetch routes both clients through the demo and nowhere else', async () => {
    const live = vi.fn(async () => { throw new Error('live backend reached') })
    vi.stubGlobal('fetch', live)
    const mod = await import('../../../lib/supabase')
    const demo = vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    mod.setSupabaseFetch(demo)
    await mod.supabase.from('a').select('*')
    await mod.createAuthenticatedClient('t').functions.invoke('intel-capture', { body: { op: 'read', view: 'fx' } })
    expect(demo).toHaveBeenCalledTimes(2)
    expect(live).not.toHaveBeenCalled()
    mod.disableSupabaseRealtime()
    const channel = mod.supabase.channel('generation_jobs:x').on('postgres_changes', {}, () => {})
    const status = vi.fn()
    channel.subscribe(status)
    expect(status).toHaveBeenCalledWith('CLOSED')
    mod.setSupabaseFetch(null)
  })
})

describe('demoFetch and the public RWA endpoint', () => {
  function forwardingClient(entries = {}) {
    const net = bucket(entries)
    const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
    const forwarded = []
    const forwardPublic = vi.fn(async (body) => {
      forwarded.push(body)
      return new Response(JSON.stringify({ forwarded: true, body }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store: createDemoStore(), forwardPublic })
    const client = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
    return { client, demoFetch, forwarded, forwardPublic, net }
  }

  it('an RWA research read the snapshot holds is answered from it, not forwarded', async () => {
    const key = demoSnapshotKey('intel-research', { capability: 'rwaList', params: { start: 1, limit: 25 } })
    const { client, forwardPublic } = forwardingClient({ [key]: RWA_LIST })
    const { data } = await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'rwaList', params: { start: 1, limit: 25 } } })
    expect(data).toEqual(RWA_LIST)
    expect(forwardPublic).not.toHaveBeenCalled()
  })

  it('a miss of each of the six RWA capabilities is forwarded with capability, params and readMode only', async () => {
    const { client, forwarded } = forwardingClient({})
    for (const capability of ['rwaList', 'rwaInfo', 'rwaQuotes', 'rwaPairs', 'issuers', 'issuer']) {
      const { data } = await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability, params: { start: 26, limit: 25 }, readMode: 'retained', extra: 'dropped' } })
      expect(data.forwarded).toBe(true)
    }
    expect(forwarded).toHaveLength(6)
    for (const body of forwarded) {
      expect(Object.keys(body).sort()).toEqual(['capability', 'params', 'readMode'])
      expect(JSON.stringify(body)).not.toContain(DEMO_ORG_ID)
    }
  })

  it('non-RWA misses and every other function keep the demo reason', async () => {
    const { client, forwardPublic } = forwardingClient({})
    const quotes = await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'quotes', params: { id: 1 } } })
    expect(quotes.data.reason).toBe(DEMO_MISS_CODE)
    const capture = await readCaptureView('rwa_depth', {}, { orgId: DEMO_ORG_ID, supabase: client }).catch((e) => e)
    expect(capture.code).toBe(DEMO_MISS_CODE)
    const generate = await client.functions.invoke('intel-generate', { body: { orgId: DEMO_ORG_ID, kind: 'brief' } })
    expect(generate.data.code).toBe(DEMO_MISS_CODE)
    expect(forwardPublic).not.toHaveBeenCalled()
  })

  it('the lookup crosses with the query alone; without a forwarder it is the demo miss', async () => {
    const { client, forwarded } = forwardingClient({})
    const { data } = await client.functions.invoke('intel-rwa-lookup', { body: { q: 'NVDA', orgId: DEMO_ORG_ID } })
    expect(data.forwarded).toBe(true)
    expect(forwarded).toEqual([{ q: 'NVDA' }])
    const { client: plain } = demoClient({})
    expect((await plain.functions.invoke('intel-rwa-lookup', { body: { q: 'NVDA' } })).data.code).toBe(DEMO_MISS_CODE)
  })

  it('"Check CoinMarketCap now" crosses as check: true, and only when it is exactly true', async () => {
    const { client, forwarded } = forwardingClient({})
    await client.functions.invoke('intel-rwa-lookup', { body: { q: 'NVDA', check: true, orgId: DEMO_ORG_ID } })
    await client.functions.invoke('intel-rwa-lookup', { body: { q: 'NVDA', check: 'yes' } })
    expect(forwarded).toEqual([{ q: 'NVDA', check: true }, { q: 'NVDA' }])
  })
})

describe('demoFetch and a snapshot copy past its refresh window', () => {
  const NOW = Date.parse('2026-09-23T15:00:00.000Z')
  const quoteBody = (fetchedAt, state = 'cached') => ({
    version: 1, capability: 'rwaQuotes', state, data: { rows: [{ rwa_id: 1, symbol: 'GOLD' }], total: 1, hasMore: false },
    provenance: { provider: 'coinmarketcap', fetchedAt, expiresAt: new Date(Date.parse(fetchedAt) + 3600_000).toISOString() },
    receipt: { origin: 'cache', fetchedAt, ttlSeconds: 3600, cacheAgeSeconds: 483 },
    freeShared: { lane: 'rwa_research', served: 'shared-cache' },
  })
  const key = demoSnapshotKey('intel-research', { capability: 'rwaQuotes', params: { rwa_id: 1 } })
  function client(stored, answer) {
    const net = bucket({ [key]: stored })
    const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
    const forwarded = []
    const forwardPublic = vi.fn(async (body, fn) => {
      forwarded.push({ fn, body })
      if (answer instanceof Error) throw answer
      return new Response(JSON.stringify(answer), { status: answer?.status === 503 ? 503 : 200, headers: { 'Content-Type': 'application/json' } })
    })
    const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store: createDemoStore(), forwardPublic, now: () => NOW })
    const c = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
    const read = async () => (await c.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'rwaQuotes', params: { rwa_id: 1 } } })).data
    return { read, forwarded }
  }

  it('the window is the copy\'s own expiry, else fetch time plus TTL; a failed copy counts as past it; unsupported never', () => {
    expect(researchCopyPastWindow(quoteBody('2026-09-23T14:30:00.000Z'), NOW)).toBe(false)
    expect(researchCopyPastWindow(quoteBody('2026-09-23T00:30:00.000Z'), NOW)).toBe(true)
    expect(researchCopyPastWindow({ state: 'cached', receipt: { fetchedAt: '2026-09-23T13:00:00.000Z', ttlSeconds: 3600 } }, NOW)).toBe(true)
    expect(researchCopyPastWindow({ state: 'cached', receipt: { fetchedAt: '2026-09-23T13:00:00.000Z', ttlSeconds: 86400 } }, NOW)).toBe(false)
    expect(researchCopyPastWindow({ state: 'cached', data: { rows: [] } }, NOW)).toBe(false)
    expect(researchCopyPastWindow({ state: 'unavailable' }, NOW)).toBe(true)
    expect(researchCopyPastWindow({ state: 'unsupported', reason: 'insufficient_entitlement' }, NOW)).toBe(false)
  })

  it('a copy past its window is forwarded as capability and params alone, and the newer shared copy answers', async () => {
    const shared = quoteBody('2026-09-23T14:52:00.000Z')
    const { read, forwarded } = client(quoteBody('2026-09-23T00:30:18.981Z'), shared)
    const data = await read()
    expect(data.provenance.fetchedAt).toBe('2026-09-23T14:52:00.000Z')
    expect(forwarded).toEqual([{ fn: 'intel-rwa-lookup', body: { capability: 'rwaQuotes', params: { rwa_id: 1 } } }])
  })

  it('a copy inside its window is served from the snapshot and nothing is forwarded', async () => {
    const { read, forwarded } = client(quoteBody('2026-09-23T14:40:00.000Z'), quoteBody('2026-09-23T14:59:00.000Z'))
    expect((await read()).provenance.fetchedAt).toBe('2026-09-23T14:40:00.000Z')
    expect(forwarded).toEqual([])
  })

  it('an unreachable endpoint, an unusable answer or an older copy leaves the snapshot copy, still dated', async () => {
    const stored = quoteBody('2026-09-23T09:00:00.000Z')
    for (const answer of [new Error('offline'), { status: 503, error: 'research_unavailable' }, { state: 'unavailable', reason: 'insufficient_entitlement' }, quoteBody('2026-09-23T08:00:00.000Z', 'stale')]) {
      const { read, forwarded } = client(stored, answer)
      expect((await read()).provenance.fetchedAt).toBe('2026-09-23T09:00:00.000Z')
      expect(forwarded).toHaveLength(1)
    }
  })

  it('a stale shared copy newer than the snapshot copy still answers, and keeps saying it is stale', async () => {
    const { read } = client(quoteBody('2026-09-23T09:00:00.000Z'), quoteBody('2026-09-23T12:00:00.000Z', 'stale'))
    const data = await read()
    expect([data.state, data.provenance.fetchedAt]).toEqual(['stale', '2026-09-23T12:00:00.000Z'])
  })

  it('a slow newer read never holds the drawer: the snapshot copy answers at once, and the newer copy answers the next read', async () => {
    const net = bucket({ [key]: quoteBody('2026-09-23T00:30:18.981Z') })
    const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
    let release
    const landed = new Promise((resolve) => { release = resolve })
    const forwarded = []
    const forwardPublic = vi.fn(async (body, fn) => {
      forwarded.push({ fn, body })
      await landed
      return new Response(JSON.stringify(quoteBody('2026-09-23T14:52:00.000Z')), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store: createDemoStore(), forwardPublic, now: () => NOW, fresherWaitMs: 20 })
    const c = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
    const read = async () => (await c.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'rwaQuotes', params: { rwa_id: 1 } } })).data
    const started = Date.now()
    const first = await read()
    expect(first.provenance.fetchedAt, 'the dated snapshot copy, served without waiting').toBe('2026-09-23T00:30:18.981Z')
    expect(Date.now() - started).toBeLessThan(1000)
    // A second read while the first check is still running shares it.
    expect((await read()).provenance.fetchedAt).toBe('2026-09-23T00:30:18.981Z')
    expect(forwarded).toHaveLength(1)
    release()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await read()).provenance.fetchedAt, 'the newer copy, kept when it landed').toBe('2026-09-23T14:52:00.000Z')
    expect(forwarded).toHaveLength(1)
  })
})

describe('demoFetch and the public read endpoint (a visitor search)', () => {
  const TRACKED_DETAIL = {
    detail: true, symbol: 'BTC', displayName: 'Bitcoin', price: 86770, sourceProvider: 'coinmarketcap', providerId: '1',
    canonicalAssetKey: 'bip122:native:BTC', identityChoices: [{ canonicalAssetKey: 'bip122:native:BTC', chain: 'bitcoin', label: 'Bitcoin' }],
    candles: [{ t: 1, o: 1, h: 2, l: 1, c: 2 }],
  }
  const UNTRACKED = { error: 'demo_untracked', code: 'demo_untracked', reason: 'demo_untracked', state: 'unavailable' }
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  // A fake intel-demo-read that knows BTC (coinmarketcap 1) and nothing else.
  function readEndpoint(body) {
    if (body.read === 'suggest') return json(body.q === 'BTC' ? { suggest: true, q: 'BTC', limit: 8, matches: [{ sourceProvider: 'coinmarketcap', providerId: '1', symbol: 'BTC', match: 'symbol_exact', href: '/intel/markets/BTC?provider=coinmarketcap&id=1' }] } : { suggest: true, q: body.q, limit: 8, matches: [], demoReason: 'demo_untracked' })
    if (body.read === 'screen') return json(body.query.search === 'BTC' ? { rows: [{ symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }], total: 1 } : { rows: [], total: 0, demoReason: 'demo_untracked' })
    if (body.read === 'detail') return body.providerId === '1' || body.symbol === 'BTC' ? json(body.mode === 'full' ? TRACKED_DETAIL : { candles: [], mode: body.mode }) : json(UNTRACKED, 403)
    if (body.read === 'venue') return json({ canonicalKey: body.canonicalKey, depth: { quotes: [] } })
    if (body.read === 'news') return json([{ id: 7, title: 'Bitcoin headline', published_at: new Date(Date.now() - 3_600_000).toISOString() }])
    return json(UNTRACKED, 403)
  }
  function searchingClient(entries = {}, endpoint = readEndpoint) {
    const net = bucket(entries)
    const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
    const forwarded = []
    const forwardPublic = vi.fn(async (body, fn) => { forwarded.push({ fn, body }); return endpoint(body, fn) })
    const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store: createDemoStore(), forwardPublic })
    const client = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
    return { client, forwarded, forwardPublic, net }
  }

  it('a tracked search and the asset it opens are answered by intel-demo-read, rebuilt without the workspace', async () => {
    const { client, forwarded } = searchingClient()
    const { suggestMarketAssets, loadMarkets, loadMarketDetail } = await import('../markets-api')
    const matches = await suggestMarketAssets(client, DEMO_ORG_ID, 'BTC')
    expect(matches.map((m) => m.providerId)).toEqual(['1'])
    const screen = await loadMarkets(client, DEMO_ORG_ID, { search: 'BTC', limit: 10, page: 0, provider: 'auto', sort: 'market_cap' })
    expect(screen.rows).toHaveLength(1)
    const detail = await loadMarketDetail(client, DEMO_ORG_ID, 'BTC', { sourceProvider: 'coinmarketcap', providerId: '1' })
    expect(detail.price).toBe(86770)
    expect(forwarded.map((f) => f.fn)).toEqual(['intel-demo-read', 'intel-demo-read', 'intel-demo-read'])
    expect(forwarded.map((f) => f.body)).toEqual([
      { read: 'suggest', q: 'BTC', limit: 8 },
      { read: 'screen', query: { provider: 'auto', sort: 'market_cap', search: 'BTC', page: 0, limit: 10 } },
      { read: 'detail', mode: 'full', symbol: 'BTC', timeframe: '7D', sourceProvider: 'coinmarketcap', providerId: '1' },
    ])
    for (const { body } of forwarded) expect(JSON.stringify(body)).not.toContain(DEMO_ORG_ID)
  })

  it('an untracked asset comes back as the calm demo_untracked reason, never a failed read', async () => {
    const { client } = searchingClient()
    const { suggestMarketAssets, loadMarkets, loadMarketDetail } = await import('../markets-api')
    const { isDemoUntrackedReason } = await import('../../demo/DemoNotInSnapshot')
    expect(await suggestMarketAssets(client, DEMO_ORG_ID, 'zzqqxxv')).toEqual([])
    const screen = await loadMarkets(client, DEMO_ORG_ID, { search: 'zzqqxxv', limit: 10, page: 0, provider: 'auto', sort: 'market_cap' })
    expect(screen.rows).toEqual([])
    expect(screen.demoReason).toBe('demo_untracked')
    const failure = await loadMarketDetail(client, DEMO_ORG_ID, 'RANDOM', { sourceProvider: 'contract', providerId: 'ethereum:0x1111111111111111111111111111111111111111' }).catch((e) => e)
    expect(failure.message).toBe('demo_untracked')
    expect(isDemoUntrackedReason(failure.message)).toBe(true)
  })

  it('what the snapshot holds is not forwarded; a screen without a search, a watchlist and other functions stay misses', async () => {
    const screenKey = demoSnapshotKey('intel-markets', { provider: 'auto', sort: 'market_cap', search: '', page: 0, limit: 50 })
    const { client, forwarded } = searchingClient({ [screenKey]: { rows: [{ symbol: 'SNAP' }], total: 1 } })
    const { loadMarkets } = await import('../markets-api')
    expect((await loadMarkets(client, DEMO_ORG_ID, { provider: 'auto', sort: 'market_cap', search: '', page: 0, limit: 50 })).rows[0].symbol).toBe('SNAP')
    await expect(loadMarkets(client, DEMO_ORG_ID, { provider: 'auto', sort: 'volume', search: '', page: 0, limit: 50 })).rejects.toThrow(/Not in today/)
    await expect(loadMarkets(client, DEMO_ORG_ID, { search: 'BTC', watchlistOnly: true })).rejects.toThrow(/Not in today/)
    const generate = await client.functions.invoke('intel-generate', { body: { orgId: DEMO_ORG_ID, kind: 'brief' } })
    expect(generate.data.code).toBe(DEMO_MISS_CODE)
    const refresh = await client.functions.invoke('token-profile-get', { body: { orgId: DEMO_ORG_ID, sourceProvider: 'coinmarketcap', providerId: '1', refresh: true } })
    expect(refresh.data.code).toBe(DEMO_MISS_CODE)
    expect(forwarded).toEqual([])
  })

  it('the venue read crosses only for a key a tracked detail named, and news crosses as its terms alone', async () => {
    const { client, forwarded } = searchingClient()
    const venue = () => client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'venueContext', params: { canonicalKey: 'bip122:native:BTC', refresh: false, requestRevision: 0 } } })
    expect((await venue()).data.reason).toBe(DEMO_MISS_CODE)
    const { loadMarketDetail } = await import('../markets-api')
    await loadMarketDetail(client, DEMO_ORG_ID, 'BTC', { sourceProvider: 'coinmarketcap', providerId: '1' })
    expect((await venue()).data.canonicalKey).toBe('bip122:native:BTC')
    expect(forwarded.at(-1).body).toEqual({ read: 'venue', canonicalKey: 'bip122:native:BTC', sourceProvider: 'coinmarketcap', providerId: '1' })
    const { loadAssetNews } = await import('../asset-news')
    const news = await loadAssetNews(client, DEMO_ORG_ID, { key: 'bip122:native:BTC', symbol: 'BTC', name: 'Bitcoin', chain: 'bitcoin', native: true })
    expect(news.rows.map((r) => r.id)).toContain(7)
    const newsBodies = forwarded.filter((f) => f.body.read === 'news').map((f) => f.body)
    expect(newsBodies.map((b) => b.table).sort()).toEqual(['intel_curated_news', 'intel_global_news'])
    expect(newsBodies.find((b) => b.table === 'intel_curated_news').terms).toEqual(['tokens.cs.{"BTC"}', 'tokens.cs.{"Bitcoin"}', 'tokens.cs.{"bitcoin:native"}', 'chains.cs.{bitcoin}'])
  })

  it('an unreachable endpoint falls back to the snapshot sentence', async () => {
    const { client } = searchingClient({}, () => { throw new Error('offline') })
    const { loadMarketDetail } = await import('../markets-api')
    const failure = await loadMarketDetail(client, DEMO_ORG_ID, 'BTC', { sourceProvider: 'coinmarketcap', providerId: '1' }).catch((e) => e)
    expect(failure.message).toMatch(/Not in today/)
  })

  it('the chart keeps its working state in memory and has no conditions yet', async () => {
    const { client, forwarded } = searchingClient()
    const { readChartWorkingState } = await import('../chart-workspace-api')
    const context = { supabase: client, orgId: DEMO_ORG_ID, userId: DEMO_USER_ID }
    expect(await readChartWorkingState(context, 'bip122:native:BTC')).toBeNull()
    const { data } = await client.functions.invoke('intel-chart-workspace', { body: { orgId: DEMO_ORG_ID, operation: 'working_save', asset: 'bip122:native:BTC', revision: 0, state: { asset: 'bip122:native:BTC', range: '7D' } } })
    expect(data.revision).toBe(1)
    expect((await readChartWorkingState(context, 'bip122:native:BTC')).state.range).toBe('7D')
    const history = await client.functions.invoke('intel-chart-workspace', { body: { orgId: DEMO_ORG_ID, operation: 'alert_history', asset: 'bip122:native:BTC', from: 1, to: 2 } })
    expect(history.data).toEqual({ rows: [], nextCursor: null })
    expect(forwarded).toEqual([])
  })
})

describe('demoFetch and a stored read newer than the snapshot copy (one freshness story)', () => {
  const NOW = Date.parse('2026-09-23T17:51:00.000Z')
  const board = (asOf, extra = {}) => ({ view: 'rwa_wrappers', asOf, rows: [{ rwaId: 1017, symbol: 'NVDA', wrappers: [{ cryptoId: 36992, referencePrice: 181.2 }] }], sourcePolicy: { exportAllowed: false }, ...extra })
  const screen = (lastUpdated) => ({ rows: [{ symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }], total: 1, lastUpdated, snapshot: { lastUpdated }, catalog: { provider: 'coinmarketcap' } })
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  function client(entries, endpoint, clock = () => NOW) {
    const net = bucket(entries)
    const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
    const forwarded = []
    const forwardPublic = vi.fn(async (body, fn) => { forwarded.push({ fn, body }); return endpoint(body, fn) })
    const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store: createDemoStore(), forwardPublic, now: clock })
    const c = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
    return { client: c, forwarded }
  }

  it('the wrapper board past its six-hour cadence is read again as a shared view, and the newer capture answers whole', async () => {
    const live = board('2026-09-23T14:00:00.000Z', { demoRead: { served: 'stored_capture', providerCalls: 0 } })
    const { client: c, forwarded } = client({ [captureKey('rwa_wrappers')]: board('2026-09-23T08:00:00.000Z') }, () => json(live))
    const read = await readCaptureView('rwa_wrappers', {}, { orgId: DEMO_ORG_ID, supabase: c })
    expect(read.asOf).toBe('2026-09-23T14:00:00.000Z')
    // Rows pass through whole: a field a later lane adds reaches the page.
    expect(read.rows[0].wrappers[0].referencePrice).toBe(181.2)
    expect(forwarded).toEqual([{ fn: 'intel-demo-read', body: { read: 'view', view: 'rwa_wrappers', params: {} } }])
    // Read again within the check window: answered from the same check.
    await readCaptureView('rwa_wrappers', {}, { orgId: DEMO_ORG_ID, supabase: c })
    expect(forwarded).toHaveLength(1)
  })

  it('crosses with the page parameters only, never orgId, op or anything unlisted', async () => {
    const { client: c, forwarded } = client({ [captureKey('venue_share', { days: 90, kind: 'spot' })]: { view: 'venue_share', asOf: '2026-09-21T00:00:00.000Z' } }, () => json({ view: 'venue_share', asOf: '2026-09-23T00:00:00.000Z' }))
    await readCaptureView('venue_share', { days: 90, kind: 'spot' }, { orgId: DEMO_ORG_ID, supabase: c })
    expect(forwarded[0].body).toEqual({ read: 'view', view: 'venue_share', params: { days: 90, kind: 'spot' } })
    expect(demoViewFor({ op: 'read', view: 'rwa_wrappers', surprise: 1 })).toBeNull()
    expect(demoViewFor({ op: 'read', view: 'rwa_asset_logos', rwaIds: [1] })).toBeNull()
    expect(demoViewFor({ op: 'read', view: 'rwa_token_depth', cryptoId: '39306' })).toEqual({ read: 'capture', view: 'rwa_token_depth', cryptoId: '39306' })
  })

  it('a copy inside its cadence is served from the snapshot and nothing is forwarded', async () => {
    const { client: c, forwarded } = client({ [captureKey('rwa_wrappers')]: board('2026-09-23T14:00:00.000Z') }, () => json(board('2026-09-23T14:00:00.000Z')))
    expect((await readCaptureView('rwa_wrappers', {}, { orgId: DEMO_ORG_ID, supabase: c })).asOf).toBe('2026-09-23T14:00:00.000Z')
    expect(forwarded).toEqual([])
  })

  it('an older, failed, rate-limited or unreachable answer leaves the snapshot copy, still dated', async () => {
    for (const endpoint of [
      () => json(board('2026-09-23T08:00:00.000Z')),
      () => json({ error: 'rate_limited', reason: 'rate_limited', retryAfter: 30 }, 429),
      () => json({ error: 'demo_read_unavailable' }, 503),
      () => { throw new Error('offline') },
    ]) {
      const { client: c, forwarded } = client({ [captureKey('rwa_wrappers')]: board('2026-09-23T08:00:00.000Z') }, endpoint)
      expect((await readCaptureView('rwa_wrappers', {}, { orgId: DEMO_ORG_ID, supabase: c })).asOf).toBe('2026-09-23T08:00:00.000Z')
      expect(forwarded).toHaveLength(1)
    }
  })

  it('the unsearched Markets screen older than the catalogue window is read again, and the newer page answers', async () => {
    const params = { provider: 'auto', sort: 'market_cap', dir: 'desc', chain: '', search: '', category: '', signalDirection: '', watchlistOnly: false, view: '', page: 0, limit: 50 }
    const key = demoSnapshotKey('intel-markets', params)
    const { client: c, forwarded } = client({ [key]: screen('2026-09-23T04:13:00.000Z') }, () => json(screen('2026-09-23T17:48:00.000Z')))
    const { loadMarkets } = await import('../markets-api')
    const data = await loadMarkets(c, DEMO_ORG_ID, params)
    expect(data.lastUpdated).toBe('2026-09-23T17:48:00.000Z')
    expect(forwarded).toEqual([{ fn: 'intel-demo-read', body: { read: 'screen', query: { provider: 'auto', sort: 'market_cap', dir: 'desc', page: 0, limit: 50, search: '' } } }])
    // A watchlist screen or a search is never refreshed this way.
    expect(demoScreenFor({ ...params, watchlistOnly: true })).toBeNull()
    expect(demoScreenFor({ ...params, op: 'suggest' })).toBeNull()
    expect(demoScreenFor({ ...params, symbol: 'BTC' })).toBeNull()
  })
})
