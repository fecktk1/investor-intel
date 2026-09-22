import { describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDemoFetch } from '../../demo/demo-fetch'
import { createDemoStore } from '../../demo/demo-store'
import { createSnapshotReader, publicObjectUrl } from '../../demo/demo-snapshot'
import { DEMO_ORG_ID, DEMO_USER_ID } from '../../demo/demo-identity'
import { listCuratedNews, pageGlobalNews } from '../news-api'
import { loadMacroCalendar, loadMacroIndicators, loadMacroNews } from '../macro-api'
import { loadRegime } from '../regime-api'
import { loadDashboard } from '../dashboard-api'
import { loadNarratives, loadNarrativeDetail, loadNarrativeHistory, loadNarrativeMembers, loadNarrativeXVelocity } from '../narratives-api'
import { loadDefiPage } from '../defi-api'
import {
  demoEntryPath, demoRequestKey, demoRestKey, demoRestRefusal, DEMO_REST_TABLES,
} from '../../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'
import {
  curatedNewsPage, currentRegimeRequest, dashboardRequests, defiBrowseRequest, globalNewsPage, macroRequests,
  narrativeDetailRequests, narrativeFeedRequest, NEWS_PAGE_SIZE, recentlyDiscoveredRequest, researchWorkspaceRequests,
} from '../../../../supabase/functions/_shared/intel/demo-snapshot-requests.ts'

// The page clients below are the real ones the pages call. Each test plants the
// body the builder would store under the key the PLAN derives for the request
// (demo-snapshot-requests.ts), then checks the real client gets it back through
// the demo fetch. A key mismatch between the plan and the page fails here.

const URL_BASE = 'https://demo-backend.supabase.co'
const NOW = Date.parse('2026-09-22T21:02:22.211Z')

function bucket(entries) {
  const date = '2026-09-22'
  const files = new Map()
  files.set(publicObjectUrl(URL_BASE, 'latest.json'), { date, capturedAt: '2026-09-22T04:13:00.000Z', version: 1, keys: Object.keys(entries) })
  for (const [key, body] of Object.entries(entries)) files.set(publicObjectUrl(URL_BASE, demoEntryPath(date, key)), { version: 1, key, status: 200, body })
  const calls = []
  const network = vi.fn(async (input) => {
    const href = String(input?.url ?? input)
    calls.push(href)
    if (!href.startsWith(publicObjectUrl(URL_BASE, ''))) throw new Error(`live backend reached: ${href}`)
    const file = files.get(href)
    return file ? new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 404 })
  })
  return { network, calls }
}

function demoClient(planned = [], { now = () => NOW } = {}) {
  const entries = {}
  for (const [request, body] of planned) entries[demoRequestKey(request)] = body
  const net = bucket(entries)
  const reader = createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: net.network })
  const store = createDemoStore()
  const misses = []
  const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader, store, now, onMiss: (m) => misses.push(m) })
  const client = createClient(URL_BASE, 'anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: demoFetch },
  })
  return { client, store, net, misses }
}

const restBody = (rows, count = rows.length) => ({ rows, count })

describe('shared tables and RPCs in the demo', () => {
  it('News: the analyzed feed and the headlines feed answer from the planned REST replays, with their counts', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      const curated = [{ id: 1, title: 'ETF inflows', final_score: 90 }]
      const headlines = [{ id: 'n1', title: 'Headline' }]
      const { client, net } = demoClient([[curatedNewsPage(0), restBody(curated, 151)], [globalNewsPage(1), restBody(headlines, 400)]])
      const sopts = { chains: null, search: null, since: null, until: null, signal: null, category: null, page: 0, pageSize: NEWS_PAGE_SIZE, limit: NEWS_PAGE_SIZE, paginated: true }
      const analyzed = await listCuratedNews(client, sopts)
      expect(analyzed).toEqual({ rows: curated, count: 151 })
      const page2 = await pageGlobalNews(client, { ...sopts, page: 1 })
      expect(page2.rows.map((r) => r.title)).toEqual(['Headline'])
      expect(page2.count).toBe(400)
      expect(net.calls.every((href) => href.includes('/storage/v1/object/public/intel-demo/'))).toBe(true)
    } finally { vi.useRealTimers() }
  })

  it('a time window is keyed by its hour offset, so a page opened minutes later still matches and a day later does not', () => {
    const at = (ms) => new URLSearchParams([['published_at', `gte.${new Date(ms - 7 * 86400000).toISOString()}`], ['published_at', `lte.${new Date(ms).toISOString()}`]]).toString()
    const later = NOW + 17 * 60_000
    expect(demoRestKey('intel_curated_news', at(later), later + 50)).toBe(demoRestKey('intel_curated_news', at(NOW), NOW + 5))
    expect(demoRestKey('intel_curated_news', at(NOW), NOW)).toBe(demoRestKey('intel_curated_news', 'published_at=gte.@-168h&published_at=lte.@0h'))
    expect(demoRestKey('intel_curated_news', at(NOW), NOW)).not.toBe(demoRestKey('intel_curated_news', 'published_at=gte.@-24h&published_at=lte.@0h'))
  })

  it('Macro: the shared RPC and both macro tables answer from the snapshot', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    try {
      const [news, indicators, calendar] = macroRequests()
      const { client } = demoClient([
        [news, [{ title: 'CPI prints hot', importance: 1.2 }]],
        [indicators, restBody([{ metric_key: 'dxy', value: 101.2 }])],
        [calendar, restBody([{ event_key: 'fomc', title: 'FOMC' }])],
      ])
      expect(await loadMacroNews(client)).toEqual([{ title: 'CPI prints hot', importance: 1.2 }])
      expect(await loadMacroIndicators(client)).toEqual([{ metric_key: 'dxy', value: 101.2 }])
      expect(await loadMacroCalendar(client)).toEqual([{ event_key: 'fomc', title: 'FOMC' }])
    } finally { vi.useRealTimers() }
  })

  it('My Intel: the dashboard sections and the current regime', async () => {
    const [core, picture] = dashboardRequests()
    const { client } = demoClient([
      [core, { scope: 'all', notable: [{ title: 'Story' }], counts: {} }],
      [picture, { intelligence_grounding: { projection: 'dashboard-picture-1' } }],
      [currentRegimeRequest(), [{ regime: 'risk_on' }]],
    ])
    expect((await loadDashboard(client, DEMO_ORG_ID, { scope: 'all', chain: null, section: 'core' })).notable).toEqual([{ title: 'Story' }])
    expect((await loadDashboard(client, DEMO_ORG_ID, { scope: 'all', chain: null, section: 'picture' })).intelligence_grounding.projection).toBe('dashboard-picture-1')
    expect(await loadRegime(client)).toEqual({ regime: 'risk_on' })
  })

  it('Narratives: the feed, a detail page, its history, its X velocity and its members', async () => {
    const id = '11111111-2222-4333-8444-555555555555'
    const [detail, history, taxonomy, velocity, members] = narrativeDetailRequests('gaming-tokens', id)
    const { client } = demoClient([
      [narrativeFeedRequest(), { narratives: [{ slug: 'gaming-tokens' }], summary: {}, count: 1 }],
      [detail, { taxonomy: { id, slug: 'gaming-tokens' }, state: {}, drivers: [], is_followed: false }],
      [history, { history: [], historyCoverage: { requestedDays: 30 } }],
      [taxonomy, restBody([{ id }])],
      [velocity, restBody([{ raw: { velocity_pct: 12.5, counts_today: 40 }, fetched_at: '2026-09-22T20:00:00Z' }])],
      [members, restBody([{ id: 'm1', asset_provider: 'coingecko', asset_provider_id: 'immutable-x', symbol: 'IMX', is_leader: true }])],
    ])
    expect((await loadNarratives(client, DEMO_ORG_ID)).narratives[0].slug).toBe('gaming-tokens')
    expect((await loadNarrativeDetail(client, DEMO_ORG_ID, 'gaming-tokens')).taxonomy.id).toBe(id)
    expect((await loadNarrativeHistory(client, 'gaming-tokens', 30, { withCoverage: true })).coverage.requestedDays).toBe(30)
    expect((await loadNarrativeXVelocity(client, 'gaming-tokens')).velocity_pct).toBe(12.5)
    const page = await loadNarrativeMembers(client, id, 0)
    expect(page.rows.map((r) => r.symbol)).toEqual(['IMX'])
  })

  it('DeFi, Market context, Discovery: the explorer pages, the research reads and the recently discovered list', async () => {
    const [global, listings] = researchWorkspaceRequests()
    const { client } = demoClient([
      [defiBrowseRequest('lending', 0), { rows: [{ key: 'm:r', symbol: 'USDC' }], total: 1, status: 'ok', source: 'cache', chain: 'solana', view: 'lending' }],
      [global, { capability: 'global', state: 'cached', data: { rows: [{ btc_dominance: 57 }] } }],
      [listings, { capability: 'listings', state: 'cached', data: { rows: [{ id: 1 }] } }],
      [recentlyDiscoveredRequest(), restBody([{ asset_key: 'market:coingecko:x', symbol: 'X' }])],
    ])
    expect((await loadDefiPage(client, DEMO_ORG_ID, { view: 'lending' })).rows[0].symbol).toBe('USDC')
    expect((await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'global', params: {} } })).data.data.rows[0].btc_dominance).toBe(57)
    expect((await client.functions.invoke('intel-research', { body: { orgId: DEMO_ORG_ID, capability: 'listings', params: { start: 1, limit: 25 } } })).data.state).toBe('cached')
    // RecentlyDiscovered.jsx:119, written as the component writes it.
    const COLUMNS = 'asset_key, provider, provider_id, symbol, name, image_url, cached_image_url, first_demanded_at, last_demanded_at, demand_count, in_use_until'
    const { data } = await client.from('intel_recently_discovered').select(COLUMNS).order('last_demanded_at', { ascending: false }).limit(12)
    expect(data).toEqual([{ asset_key: 'market:coingecko:x', symbol: 'X' }])
  })

  it('a personal table is never answered from the snapshot, even if a file for it existed', async () => {
    const planted = { fn: 'rest', body: { table: 'watchlists', query: `select=*&org_id=eq.${DEMO_ORG_ID}` } }
    expect(demoRestRefusal('watchlists', planted.body.query)).toBe('personal_table')
    const { client } = demoClient([[planted, restBody([{ id: 'leak', name: 'Someone else' }])]])
    expect((await client.from('watchlists').select('*').eq('org_id', DEMO_ORG_ID)).data).toEqual([])
    // Owner filters, embeds and personal columns are refused on a shared table too.
    expect(demoRestRefusal('intel_curated_news', `select=id&user_id=eq.${DEMO_USER_ID}`)).toBe('owner_or_personal_filter')
    expect(demoRestRefusal('intel_curated_news', 'select=id,entity:entities(display_symbol)')).toBe('embedded_resource')
    expect(demoRestRefusal('intel_global_news', 'select=*')).toBe('select_star')
    expect(demoRestRefusal('narrative_signals', 'select=author_email')).toBe('owner_or_personal_column')
    expect(demoRestRefusal('intel_curated_news', `select=id&or=(user_id.eq.${DEMO_USER_ID},id.eq.1)`)).toBe('owner_or_personal_filter')
    for (const table of Object.keys(DEMO_REST_TABLES)) expect(demoRestRefusal(table, 'select=id')).toBeNull()
  })

  it('personal reads stay empty: the signals ranked for a member and the workspace news sources', async () => {
    const { client, misses } = demoClient([])
    expect((await client.rpc('signal_feed_v2', { p_org_id: DEMO_ORG_ID, p_subject_type: null, p_chains: null, p_limit: 24 })).data).toEqual([])
    expect((await client.from('tracked_sources').select('*').eq('org_id', DEMO_ORG_ID)).data).toEqual([])
    expect(misses.some((m) => m.kind === 'rest' && m.table === 'tracked_sources')).toBe(true)
  })
})
