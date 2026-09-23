// @vitest-environment jsdom
// The Markets page in the public demo, driven for real: MarketsPage.jsx renders
// against a Supabase client whose every request goes through the demo fetch,
// and the bucket holds a body for every key the snapshot PLAN names
// (demo-snapshot-requests.ts marketsRequests / degenRequests). Any request the
// page sends that the plan does not name is a miss, and the test fails on it.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createDemoFetch } from '../../demo/demo-fetch'
import { createDemoStore } from '../../demo/demo-store'
import { createSnapshotReader, publicObjectUrl } from '../../demo/demo-snapshot'
import { DEMO_ORG_ID, DEMO_USER_ID } from '../../demo/demo-identity'
import { CHAINS } from '../chains'
import { loadMarkets } from '../markets-api'
import { demoEntryPath, demoRequestKey, demoSnapshotKey } from '../../../../supabase/functions/_shared/intel/demo-snapshot-key.ts'
import {
  currentRegimeRequest, degenRequests, marketMacroRequest, degenScreenRequest, marketsRequests, marketsScreenRequest, MARKET_SORTS, recentlyDiscoveredRequest,
} from '../../../../supabase/functions/_shared/intel/demo-snapshot-requests.ts'
import { marketScreenResponse } from '../../../../supabase/functions/_shared/intel/markets-screen.ts'

const URL_BASE = 'https://demo-backend.supabase.co'
const state = vi.hoisted(() => ({ client: null }))
vi.mock('../../../lib/profile-context', () => ({ useProfile: () => ({ org: { id: '00000000-0000-4000-8000-00000000d3e0' }, profile: null }) }))
vi.mock('../../../lib/useSupabase', () => ({ useSupabase: () => ({ supabase: state.client, user: { id: '00000000-0000-4000-8000-00000000d3e1' } }) }))

const iso = (h) => new Date(Date.now() + h * 3_600_000).toISOString()
const asset = (id, extra = {}) => ({
  source_provider: 'coinmarketcap', provider_id: id, symbol: `TKN${id}`, name: `Token ${id}`, normalized_symbol: `TKN${id}`, primary_chain: 'ethereum',
  platforms: { ethereum: `0x${id}` }, market_cap_rank: Number(id), current_price: 2.5, change_1h_pct: 0.1, change_24h_pct: 3, change_7d_pct: -1,
  market_cap: 5e9 / Number(id), volume_24h: 1e8, fdv: 6e9, categories: ['Layer 1'], as_of: iso(-0.05), last_refreshed_at: iso(-0.05), on_watchlist: false, ...extra,
})
const screen = (records, total = 1000) => marketScreenResponse({
  records, total, page: 0, limit: 50, sort: 'market_cap', dir: 'desc',
  catalog: { provider: 'coinmarketcap', requested: 'auto', fallback: false, available: [] },
  snapshot: { trackedAssets: 1000, up24h: 610, down24h: 380, lastUpdated: iso(-0.05) },
  topGainers: records.slice(0, 2), topLosers: [], topByMarketCap: records.slice(0, 2), watchlistMovers: [],
  availableCategories: ['Layer 1', 'Memes'], categoryLeaders: [], chainHeatmap: [], crossExchangeSpreads: [], providerStatus: [],
  derivedCounts: { unusual_volume: 0, vol_up_price_flat: 0, price_up_liq_weak: 3, multi_exchange: 0, thin_liquidity: 70 },
})
const marketsBody = (request) => ({
  ...screen([asset(String(request.body.page * 50 + 1)), asset(String(request.body.page * 50 + 2), { change_24h_pct: 0 })]),
  receipt: null, figureProvenance: {}, nativeChains: [], nativeChainsUnavailable: false,
})
const degenBody = () => ({
  snapshot: { total: 1, verifiedCount: 1 }, rows: [{ chain: 'solana', tokenAddress: 'So1', symbol: 'MEME', name: 'Meme', price: 0.01, change24hPct: 12, volume24hUsd: 1e6, liquidityUsd: 2e5, marketCap: 1e7, discoveryReasons: ['trending'], source: 'dexscreener', detailHref: '/intel/asset/solana%3ASo1' }],
  total: 1, page: 0, limit: 50, sort: 'trending', dir: 'desc', showExcluded: false, excluded: { total: 0 },
})

// Everything the snapshot plans for this page: the Markets and Degen screens,
// the two capture/REST reads the page body mounts, written as the plan writes them.
function plannedEntries() {
  const entries = {}
  for (const request of marketsRequests(CHAINS.map((c) => c.id), { total: 1000, categories: ['Layer 1', 'Memes'], derivedCounts: { thin_liquidity: 70, price_up_liq_weak: 3 } })) entries[demoRequestKey(request)] = marketsBody(request)
  for (const request of degenRequests({ total: 1 })) entries[demoRequestKey(request)] = degenBody()
  // demo-snapshot-plan.ts staticCaptureRequests: capture('unusual_moves', { limit: 25 }).
  entries[demoRequestKey({ fn: 'intel-capture', body: { limit: 25, op: 'read', view: 'unusual_moves' } })] = { view: 'unusual_moves', rows: [], state: 'empty' }
  // The expanded market context: RegimeRibbon (regime, default range), BreadthSpread and RegimeBanner.
  entries[demoRequestKey({ fn: 'intel-capture', body: { range: '30d', op: 'read', view: 'regime' } })] = { view: 'regime', days: [] }
  entries[demoRequestKey({ fn: 'intel-capture', body: { op: 'read', view: 'breadth' } })] = { view: 'breadth', rows: [] }
  entries[demoRequestKey(currentRegimeRequest())] = [{ regime: 'risk_on', confidence: 0.7 }]
  entries[demoRequestKey(recentlyDiscoveredRequest())] = { rows: [{ asset_key: 'market:coingecko:x', provider: 'coingecko', provider_id: 'x', symbol: 'X', name: 'X' }], count: 1 }
  entries[demoRequestKey(marketMacroRequest())] = { rows: [{ provider: 'coingecko', total_market_cap_usd: 3.1e12, btc_dominance_pct: 57.2, as_of: iso(-1) }], count: 1 }
  return entries
}

function demoClient(entries) {
  const date = '2026-09-22'
  const files = new Map([[publicObjectUrl(URL_BASE, 'latest.json'), { date, capturedAt: iso(-1), version: 1, keys: Object.keys(entries) }]])
  for (const [key, body] of Object.entries(entries)) files.set(publicObjectUrl(URL_BASE, demoEntryPath(date, key)), { version: 1, key, status: 200, body })
  const network = vi.fn(async (input) => {
    const href = String(input?.url ?? input)
    if (!href.startsWith(publicObjectUrl(URL_BASE, ''))) throw new Error(`live backend reached: ${href}`)
    const file = files.get(href)
    return file ? new Response(JSON.stringify(file), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response('{}', { status: 404 })
  })
  const misses = [], sent = []
  const inner = createDemoFetch({ supabaseUrl: URL_BASE, reader: createSnapshotReader({ supabaseUrl: URL_BASE, fetchImpl: network }), store: createDemoStore(), onMiss: (m) => misses.push(m) })
  const demoFetch = async (input, init) => {
    const href = String(input?.url ?? input)
    const fn = href.match(/\/functions\/v1\/([^/?#]+)/)?.[1]
    if (fn) sent.push({ fn, body: JSON.parse(init?.body || '{}') })
    return inner(input, init)
  }
  const client = createClient(URL_BASE, 'anon-key', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: demoFetch } })
  return { client, misses, sent }
}

let root, host, where
function Where() { where = useLocation(); return null }
const settle = async () => { for (let i = 0; i < 12; i++) await act(() => new Promise((r) => setTimeout(r, 15))) }
async function renderPage(url) {
  const { default: MarketsPage } = await import('../../pages/MarketsPage')
  await act(() => root.render(<MemoryRouter initialEntries={[url]}><Where /><Routes><Route path="/intel/markets" element={<MarketsPage />} /></Routes></MemoryRouter>))
  await settle()
}
const click = async (el) => { await act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))); await settle() }
// react-i18next has no instance here, so a label is its default text or its key.
const buttonNamed = (text, scope = 'button') => {
  const found = [...host.querySelectorAll(scope)].find((b) => b.textContent.trim().toLowerCase().replace(/_/g, ' ').startsWith(text.toLowerCase()))
  if (!found) throw new Error(`no button "${text}" among: ${[...host.querySelectorAll(scope)].map((b) => b.textContent.trim()).join(' | ')}`)
  return found
}
const functionMisses = (misses) => misses.filter((m) => m.kind === 'function')

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  try { localStorage.clear() } catch { /* jsdom */ }
})
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('Markets in the demo', () => {
  it('the first load, a column sort, the next page, a derived view and the Degen tab are all answered by planned keys', async () => {
    const demo = demoClient(plannedEntries())
    state.client = demo.client
    await renderPage('/intel/markets')
    expect(host.textContent).toContain('TKN1')
    expect(host.textContent).not.toMatch(/could not be refreshed|could not be loaded|Not in today/)
    const first = demo.sent.filter((s) => s.fn === 'intel-markets')
    expect(first.length).toBeGreaterThan(0)
    expect(demoSnapshotKey('intel-markets', first[0].body)).toBe(demoRequestKey(marketsScreenRequest()))

    // Sort by a column header (Price opens descending), then back ascending.
    await click(buttonNamed('price', 'th button'))
    expect(where.search).toContain('m_sort=price')
    await click(buttonNamed('price', 'th button'))
    expect(where.search).toContain('m_dir=asc')
    expect(host.textContent).toContain('TKN1')

    // The next page in that order.
    await click(buttonNamed('next'))
    expect(where.search).toContain('m_page=1')
    expect(host.textContent).toContain('TKN51')

    // A fresh visit: the next page of the default order, then a derived view.
    await act(() => root.unmount()); root = createRoot(host)
    await renderPage('/intel/markets')
    await click(buttonNamed('next'))
    expect(where.search).toBe('?m_page=1')
    expect(host.textContent).toContain('TKN51')
    // The derived views live in the expanded market context.
    await act(() => root.unmount()); root = createRoot(host)
    await renderPage('/intel/markets?context=1')
    await click(buttonNamed('thin liquidity'))
    expect(where.search).toContain('m_view=thin_liquidity')
    expect(host.textContent).toContain('TKN1')
    // The macro bar is a planned shared-table read (market_macro_available).
    expect(demo.misses.filter((m) => m.kind === 'rest' && m.table === 'market_macro_available')).toEqual([])
    // Rank movers depend on the rows they read, so they are not planned: a miss
    // with an error the page shows, never an empty ranking history.
    expect(demo.misses.some((m) => m.kind === 'rest' && m.table === 'market_rankings_available')).toBe(true)
    expect(host.textContent).toMatch(/rank_history_failed|Ranking history could not be loaded/)
    // Only personal reads (the visitor's own watchlist) besides.
    expect(demo.misses.filter((m) => m.kind !== 'function' && !['market_rankings_available', 'watchlists', 'watchlist_items', 'intel_workspace_preferences'].includes(m.table))).toEqual([])

    // The Degen screen.
    await click(buttonNamed('degen'))
    expect(where.search).toContain('mode=degen')
    expect(host.textContent).toContain('MEME')
    expect(demo.sent.some((s) => s.fn === 'intel-degen')).toBe(true)

    expect(functionMisses(demo.misses)).toEqual([])
    expect(host.textContent).not.toMatch(/Not in today/)
  })

  it('every sort the page offers and every chain in its select is planned, both directions, as the page sends it', async () => {
    const { client, misses } = demoClient(plannedEntries())
    const base = { provider: 'auto', chain: '', search: '', category: '', signalDirection: '', watchlistOnly: false, view: '', page: 0, limit: 50 }
    for (const sort of MARKET_SORTS) for (const dir of ['asc', 'desc']) expect((await loadMarkets(client, DEMO_ORG_ID, { ...base, sort, dir })).rows.length).toBe(2)
    for (const chain of CHAINS.map((c) => c.id)) await loadMarkets(client, DEMO_ORG_ID, { ...base, sort: 'market_cap', dir: 'desc', chain })
    for (const page of [1, 5, 19]) await loadMarkets(client, DEMO_ORG_ID, { ...base, sort: 'market_cap', dir: 'desc', page })
    await loadMarkets(client, DEMO_ORG_ID, { ...base, sort: 'market_cap', dir: 'desc', category: 'Memes' })
    expect(misses).toEqual([])
    // A watchlist screen is personal: never planned, so the demo says so rather than showing an empty table.
    await expect(loadMarkets(client, DEMO_ORG_ID, { ...base, sort: 'market_cap', dir: 'desc', watchlistOnly: true })).rejects.toThrow(/Not in today/)
    expect(DEMO_USER_ID).toBeTruthy()
    expect(demoRequestKey(degenScreenRequest())).toBe(demoSnapshotKey('intel-degen', { orgId: DEMO_ORG_ID, sort: 'trending', dir: 'desc', showExcluded: false, page: 0, limit: 50 }))
  })
})
