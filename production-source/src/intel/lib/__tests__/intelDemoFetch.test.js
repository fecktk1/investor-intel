import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDemoFetch, DEMO_MISS_CODE, demoAccountAccess } from '../../demo/demo-fetch'
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
})
