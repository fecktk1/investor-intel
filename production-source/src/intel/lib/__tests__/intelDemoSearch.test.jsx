// @vitest-environment jsdom
// A visitor's own search in the public demo, on the real Markets page: the
// search the snapshot cannot hold is answered by intel-demo-read (the public
// read endpoint) for an asset we actively track, and an asset we do not track
// gets the calm "not among the assets this demo tracks" sentence, never an
// error and never an alert. The endpoint itself is a fake here; its server-side
// allowlist is tested in supabase/functions/_shared/intel/demo-read.test.ts.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDemoFetch, DEMO_READ_FUNCTION } from '../../demo/demo-fetch'
import { createDemoStore } from '../../demo/demo-store'
import { createSnapshotReader, publicObjectUrl } from '../../demo/demo-snapshot'
import { setIntelDemoActive } from '../../demo/demo-mode'
import { DEMO_ORG_ID } from '../../demo/demo-identity'
import { marketScreenResponse } from '../../../../supabase/functions/_shared/intel/markets-screen.ts'

const URL_BASE = 'https://demo-backend.supabase.co'
const state = vi.hoisted(() => ({ client: null }))
vi.mock('../../../lib/profile-context', () => ({ useProfile: () => ({ org: { id: '00000000-0000-4000-8000-00000000d3e0' }, profile: null }) }))
vi.mock('../../../lib/useSupabase', () => ({ useSupabase: () => ({ supabase: state.client, user: { id: '00000000-0000-4000-8000-00000000d3e1' } }) }))
// A STABLE t that resolves against the real English namespace, so this suite
// also proves the demo's new sentence exists in en/intel.json.
vi.mock('react-i18next', async () => {
  const en = (await import('../../../i18n/locales/en/intel.json')).default
  const t = (key, options = {}) => {
    const found = String(key).split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), en)
    const value = typeof found === 'string' ? found : (options.defaultValue ?? key)
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options[name] ?? ''))
  }
  return { useTranslation: () => ({ t, i18n: { language: 'en', changeLanguage: () => Promise.resolve() } }) }
})

const iso = (h) => new Date(Date.now() + h * 3_600_000).toISOString()
const row = (extra = {}) => ({
  source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin', normalized_symbol: 'BTC', primary_chain: null, platforms: null,
  market_cap_rank: 1, current_price: 86770, change_1h_pct: 0.1, change_24h_pct: 1.4, change_7d_pct: 14.5, market_cap: 1.74e12, volume_24h: 3.8e10, fdv: 1.82e12,
  categories: ['Layer 1'], as_of: iso(-0.05), last_refreshed_at: iso(-0.05), on_watchlist: false, ...extra,
})
const screenBody = (records, extra = {}) => ({
  ...marketScreenResponse({
    records, total: records.length, page: 0, limit: 50, sort: 'market_cap', dir: 'desc',
    catalog: { provider: 'coinmarketcap', requested: 'auto', fallback: false, available: [] },
    snapshot: { trackedAssets: 1000, up24h: 600, down24h: 390, lastUpdated: iso(-0.05) },
    topGainers: [], topLosers: [], topByMarketCap: records, watchlistMovers: [], availableCategories: ['Layer 1'], categoryLeaders: [],
    chainHeatmap: [], crossExchangeSpreads: [], providerStatus: [], derivedCounts: {},
  }),
  receipt: null, figureProvenance: {}, nativeChains: [], nativeChainsUnavailable: false, ...extra,
})

// No snapshot at all: every read the search makes is a miss, so only the
// public read endpoint (the fake below) can answer it.
function searchingClient(endpoint) {
  const network = vi.fn(async (input) => {
    const href = String(input?.url ?? input)
    if (!href.startsWith(publicObjectUrl(URL_BASE, ''))) throw new Error(`live backend reached: ${href}`)
    return new Response('{}', { status: 404 })
  })
  const forwarded = []
  const forwardPublic = vi.fn(async (body, fn) => {
    forwarded.push({ fn, body })
    const [status, answer] = endpoint(body)
    return new Response(JSON.stringify(answer), { status, headers: { 'Content-Type': 'application/json' } })
  })
  const demoFetch = createDemoFetch({ supabaseUrl: URL_BASE, reader: createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: network }), store: createDemoStore(), forwardPublic })
  const client = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
  return { client, forwarded, network }
}

let root, host
// A search screen waits 200 ms for a pause in typing before it reads.
const settle = async () => { for (let i = 0; i < 40; i++) await act(() => new Promise((r) => setTimeout(r, 15))) }
async function renderMarkets(url) {
  const { default: MarketsPage } = await import('../../pages/MarketsPage')
  await act(() => root.render(<MemoryRouter initialEntries={[url]}><Routes><Route path="/intel/markets" element={<MarketsPage />} /></Routes></MemoryRouter>))
  await settle()
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  try { localStorage.clear() } catch { /* jsdom */ }
  setIntelDemoActive(true)
})
afterEach(async () => { await act(() => root.unmount()); host.remove(); setIntelDemoActive(false); vi.restoreAllMocks() })

describe('a visitor search in the demo', () => {
  it('a tracked search fills the Markets screen from intel-demo-read, never an error', async () => {
    const { client, forwarded } = searchingClient((body) => (body.read === 'screen'
      ? [200, screenBody([row()])]
      : [200, { suggest: true, matches: [] }]))
    state.client = client
    await renderMarkets('/intel/markets?m_search=BTC')
    expect(host.textContent).toContain('Bitcoin')
    expect(host.textContent).not.toMatch(/could not be refreshed|could not be loaded|Not among the assets/)
    const screens = forwarded.filter((f) => f.body.read === 'screen')
    expect(screens.length).toBeGreaterThan(0)
    expect(screens.every((f) => f.fn === DEMO_READ_FUNCTION)).toBe(true)
    expect(screens[0].body.query.search).toBe('BTC')
    expect(JSON.stringify(forwarded)).not.toContain(DEMO_ORG_ID)
  })

  it('an untracked search says calmly that the demo does not track it, with the free-account path', async () => {
    const { client } = searchingClient((body) => (body.read === 'screen'
      ? [200, screenBody([], { demoReason: 'demo_untracked' })]
      : [200, { suggest: true, matches: [], demoReason: 'demo_untracked' }]))
    state.client = client
    await renderMarkets('/intel/markets?m_search=0x1111111111111111111111111111111111111111')
    expect(host.textContent).toContain('Not among the assets this demo tracks.')
    expect(host.querySelector('[data-demo-not-tracked] a')?.getAttribute('href')).toBe('/intel/signup?plan=free')
    expect(host.textContent).not.toMatch(/could not be refreshed|could not be loaded|No assets match this screen/)
    // No alert about the search. (With no snapshot in this suite, the unrelated
    // "Unusual for this asset" panel keeps its own snapshot sentence.)
    const alerts = [...host.querySelectorAll('[role="alert"]')].map((node) => node.textContent)
    expect(alerts.filter((text) => /refresh|market screen|suggestions|not among/i.test(text))).toEqual([])
  })

  it('a tracked asset outside the screen (an RWA wrapper past rank 1,000) is named as a link, never "untracked"', async () => {
    const sgov = { sourceProvider: 'coinmarketcap', providerId: '39306', symbol: 'SGOVON', displayName: 'iShares 0-3 Month Treasury Bond Tokenized ETF (Ondo)', href: '/intel/markets/SGOVON?provider=coinmarketcap&id=39306' }
    const { client } = searchingClient((body) => (body.read === 'screen'
      ? [200, screenBody([], { demoSuggestions: [sgov] })]
      : [200, { suggest: true, matches: [sgov] }]))
    state.client = client
    await renderMarkets('/intel/markets?m_search=SGOVon')
    expect(host.textContent).toContain('Tracked in this demo, outside the current screen:')
    expect(host.querySelector('[data-demo-outside-screen] a')?.getAttribute('href')).toBe(sgov.href)
    expect(host.textContent).not.toMatch(/Not among the assets|could not be refreshed|could not be loaded/)
    // The workspace search (Ctrl K) offers it too.
    const { searchIntelAssets } = await import('../workspace-search')
    const rows = await searchIntelAssets(client, DEMO_ORG_ID, 'SGOVon')
    expect(rows.map((r) => r.to)).toEqual([sgov.href])
    expect(rows.demoUntracked).toBeUndefined()
  })

  it('the workspace search names an untracked query for the shell to explain', async () => {
    const { client } = searchingClient(() => [200, screenBody([], { demoReason: 'demo_untracked', demoSuggestions: [] })])
    const { searchIntelAssets } = await import('../workspace-search')
    const rows = await searchIntelAssets(client, DEMO_ORG_ID, 'zzqqxxv')
    expect(rows).toHaveLength(0)
    expect(rows.demoUntracked).toBe(true)
  })

  it('outside the demo nothing changes: an empty search keeps the member sentence', async () => {
    setIntelDemoActive(false)
    const { client } = searchingClient(() => [200, screenBody([], { demoReason: 'demo_untracked' })])
    state.client = client
    await renderMarkets('/intel/markets?m_search=zzqqxxv')
    expect(host.textContent).not.toContain('Not among the assets this demo tracks.')
  })
})
