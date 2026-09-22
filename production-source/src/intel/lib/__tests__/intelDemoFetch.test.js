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
