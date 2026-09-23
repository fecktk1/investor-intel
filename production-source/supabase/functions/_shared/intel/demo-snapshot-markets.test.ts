// Tests for the demo snapshot's Markets and Degen screens: the public readers
// return the body the live Edge Functions return for a visitor with nothing
// saved, refuse everything else, and the plan names the requests exactly as
// MarketsPage.jsx sends them.

import { assert, assertEquals as eq } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { finalizePlan, type DemoRequest } from './demo-snapshot-builder.ts'
import { demoRestRefusal, demoSnapshotKey } from './demo-snapshot-key.ts'
import {
  DEGEN_BUCKETS, DEGEN_SORTS, degenRequests, degenScreenRequest, MARKET_SORTS, MARKET_VIEWS, marketsRequests, marketsScreenRequest,
  MARKETS_CATEGORIES, MARKETS_DEFAULT_PAGES, marketMacroRequest,
} from './demo-snapshot-requests.ts'
import { marketsScreenRefusal, planMarketsRequests, publicDegenReader, publicMarketsReader, sharedFunctionReaders } from './demo-snapshot-shared.ts'
import { marketScreenResponse, MARKET_SCREEN_SORTS } from './markets-screen.ts'
import { screenProvenance } from './market-provenance.ts'
import { DEGEN_SORT_KEYS } from '../memecoin/degen-query.ts'
import { degenScreenBody, degenScreenRows } from '../memecoin/degen-read.ts'
import { CHAINS } from '../chains.ts'
import { fakeDb } from './demo-snapshot-fakes.test-helpers.ts'

const NOW = Date.parse('2026-09-22T21:00:00.000Z')
const iso = (offsetHours: number) => new Date(Date.now() + offsetHours * 3_600_000).toISOString()

// deno-lint-ignore no-explicit-any
type Any = any

const asset = (id: string, extra: Record<string, unknown> = {}) => ({
  source_provider: 'coinmarketcap', provider_id: id, symbol: `S${id}`, name: `Asset ${id}`, normalized_symbol: `S${id}`,
  primary_chain: 'ethereum', platforms: { ethereum: `0x${id}` }, market_cap_rank: Number(id), current_price: 1.5, change_24h_pct: 2,
  market_cap: 1_000_000, volume_24h: 5000, categories: ['Layer 1'], as_of: iso(-0.05), on_watchlist: false, ...extra,
})
const SCREEN = {
  records: [asset('1'), asset('2', { change_24h_pct: 0 })], total: 1000, page: 0, limit: 50, sort: 'market_cap', dir: 'desc',
  catalog: { provider: 'coinmarketcap', requested: 'auto', fallback: false, available: [] },
  snapshot: { trackedAssets: 1000, up24h: 600, down24h: 390, lastUpdated: iso(-0.05) },
  topGainers: [asset('1')], topLosers: [], topByMarketCap: [asset('1')], watchlistMovers: [],
  availableCategories: ['DeFi', 'Layer 1', 'Memes'], categoryLeaders: [{ category: 'Memes', leaders: [asset('3', { categories: ['Memes'] })] }],
  derivedCounts: { unusual_volume: 0, vol_up_price_flat: 0, price_up_liq_weak: 4, multi_exchange: 0, thin_liquidity: 120 },
  crossExchangeSpreads: [], chainHeatmap: [{ chain: 'ethereum', avg_change_24h_pct: 1.2 }], providerStatus: [],
}

function screenDb(screen: unknown = SCREEN, error: unknown = null) {
  const rpcs: { name: string; args: Any }[] = []
  const db = { ...fakeDb(), rpc: (name: string, args: Any) => { rpcs.push({ name, args }); return Promise.resolve({ data: error ? null : screen, error }) } }
  return { db, rpcs }
}
const chains = async () => ({ rows: [{ chain_id: 'ethereum', price: 2500 }], unavailable: false })

// ─── the Markets screen ─────────────────────────────────────────────────────

Deno.test('the public Markets reader is the live assembly over the public screen RPC', async () => {
  const { db, rpcs } = screenDb()
  const request = marketsScreenRequest()
  const read = await publicMarketsReader(db, chains)(request.body, NOW)
  assert(read)
  eq(read!.status, 200)
  eq(rpcs, [{ name: 'intel_markets_screen_public', args: { p_query: request.body } }])
  const formatted = marketScreenResponse(SCREEN)
  const { receipt, figureProvenance } = screenProvenance(formatted)
  const clockless = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'checkedAt' || k === 'ageSeconds' ? null : x)))
  eq(clockless(read!.body), clockless({ ...formatted, receipt, figureProvenance, nativeChains: [{ chain_id: 'ethereum', price: 2500 }], nativeChainsUnavailable: false }))
  // deno-lint-ignore no-explicit-any
  const body = read!.body as any
  eq(body.rows.length, 2)
  eq(body.rows[1].change24hPct, 0, 'a valid zero stays a zero')
  eq(body.watchlistMovers, [])
  assert(body.rows.every((r: Any) => r.onWatchlist === false))
})

Deno.test('intel-markets returns exactly that assembly (source check)', async () => {
  const source = await Deno.readTextFile(new URL('../../intel-markets/index.ts', import.meta.url))
  assert(source.includes("import { marketScreenResponse } from '../_shared/intel/markets-screen.ts'"))
  assert(source.includes("admin.rpc('intel_markets_screen_for_user', { p_org_id: orgId, p_user_id: actor.userId, p_query: body })"))
  assert(/const formatted=marketScreenResponse\(screen\)[\s\S]{0,300}const \{receipt,figureProvenance\}=screenProvenance\(formatted\)\s+return json\(\{\.\.\.formatted,receipt,figureProvenance,nativeChains:nativeChains\.rows,nativeChainsUnavailable:nativeChains\.unavailable\}\)/.test(source))
  assert(source.includes('readChains(admin).catch(()=>({rows:[],unavailable:true}))'))
})

Deno.test('the public Markets reader refuses suggest, detail, history and watchlist screens before any read', async () => {
  const { db, rpcs } = screenDb()
  const reader = publicMarketsReader(db, chains)
  for (const body of [
    { op: 'suggest', q: 'bit', limit: 8 }, { history: true, symbol: 'BTC' }, { symbol: 'BTC', timeframe: '7D' },
    { sourceProvider: 'coinmarketcap', providerId: '1' }, marketsScreenRequest({ watchlistOnly: true }).body,
  ]) {
    assert(marketsScreenRefusal(body), JSON.stringify(body))
    eq(await reader(body, NOW), null)
  }
  eq(rpcs, [])
  // A failed screen read is not an empty table: the entry is left out.
  eq(await publicMarketsReader(screenDb(null, { code: '22023', message: 'Invalid markets query' }).db, chains)(marketsScreenRequest().body, NOW), null)
  eq(await publicMarketsReader(screenDb(null).db, chains)(marketsScreenRequest().body, NOW), null)
  eq(typeof sharedFunctionReaders(fakeDb())['intel-markets'], 'function')
})

Deno.test('the migration derives the public screen from the live one and keeps it service-role only', async () => {
  const dir = new URL('../../../migrations/', import.meta.url)
  const names: string[] = []
  for await (const entry of Deno.readDir(dir)) if (entry.name.endsWith('_intel_markets_screen_public.sql')) names.push(entry.name)
  eq(names.length, 1)
  const sql = await Deno.readTextFile(new URL(names[0], dir))
  assert(sql.includes("pg_get_functiondef('public.intel_markets_screen_for_user(uuid,uuid,jsonb)'::regprocedure)"))
  assert(sql.includes("'CREATE OR REPLACE FUNCTION public.intel_markets_screen_public(p_query jsonb)'"))
  assert(sql.includes("'USING NULL::uuid,v_search,'"), 'no workspace reaches the watchlist join')
  assert(sql.includes("IF COALESCE((p_query->>''watchlistOnly'')::boolean,false)"), 'a watchlist screen is refused')
  // Every replace is guarded, and no member reference may survive.
  eq((sql.match(/IF step=changed THEN RAISE EXCEPTION/g) || []).length, 5)
  assert(sql.includes("position('p_org_id' in changed)>0 OR position('p_user_id' in changed)>0"))
  assert(/REVOKE ALL ON FUNCTION public\.intel_markets_screen_public\(jsonb\) FROM PUBLIC,anon,authenticated;/.test(sql))
  assert(/GRANT EXECUTE ON FUNCTION public\.intel_markets_screen_public\(jsonb\) TO service_role;/.test(sql))
  assert(!/GRANT[^;]*(anon|authenticated)/.test(sql))
})

// ─── the plan ────────────────────────────────────────────────────────────────

Deno.test('the default Markets request is the body MarketsPage.jsx sends, minus orgId', () => {
  const page = {
    orgId: 'org', provider: 'auto', sort: 'market_cap', dir: 'desc', chain: '', search: '', category: '', signalDirection: '',
    watchlistOnly: false, view: '', page: 0, limit: 50,
  }
  eq(demoSnapshotKey('intel-markets', page), demoSnapshotKey('intel-markets', marketsScreenRequest().body))
  // Rank and drawdown open ascending (ASCENDING_FIRST); an unset m_dir never reaches the wire as ''.
  eq(marketsScreenRequest({ sort: 'rank' }).body.dir, 'asc')
  eq(marketsScreenRequest({ sort: 'drawdown' }).body.dir, 'asc')
  eq(marketsScreenRequest({ sort: 'volume' }).body.dir, 'desc')
  // Every sort the plan offers is one the database accepts, and every accepted sort is planned.
  eq([...MARKET_SORTS].sort(), [...MARKET_SCREEN_SORTS].sort())
  eq(DEGEN_SORTS, [...DEGEN_SORT_KEYS])
  eq(DEGEN_BUCKETS.includes('watchlist'), false)
  eq(demoSnapshotKey('intel-degen', { orgId: 'org', sort: 'trending', dir: 'desc', showExcluded: false, page: 0, limit: 50 }), demoSnapshotKey('intel-degen', degenScreenRequest().body))
})

Deno.test('the Markets plan: default pages, every column both ways, views, chains, categories, catalogues; never a watchlist', async () => {
  const plan = await planMarketsRequests(fakeDb(), NOW, {
    markets: async () => ({ status: 200, body: { ...marketScreenResponse(SCREEN) } }),
    degen: async () => ({ status: 200, body: { total: 180, rows: [{ chain: 'solana' }, { chain: 'sui' }] } }),
  })
  const keyed = finalizePlan(plan as DemoRequest[])
  const markets = keyed.filter((r) => r.fn === 'intel-markets'), degen = keyed.filter((r) => r.fn === 'intel-degen')
  const bodies = markets.map((r) => r.body as Any)
  eq(bodies.filter((b) => b.sort === 'market_cap' && b.dir === 'desc' && !b.view && !b.chain && !b.category && b.provider === 'auto').map((b) => b.page),
    Array.from({ length: MARKETS_DEFAULT_PAGES }, (_, i) => i))
  for (const sort of MARKET_SORTS) {
    for (const dir of ['asc', 'desc']) for (const page of [0, 1]) assert(bodies.some((b) => b.sort === sort && b.dir === dir && b.page === page && !b.view && !b.chain && !b.category), `${sort} ${dir} ${page}`)
  }
  for (const [view, sort] of MARKET_VIEWS) assert(bodies.some((b) => b.view === view && b.sort === (sort ?? 'market_cap') && b.page === 0), view)
  eq(bodies.filter((b) => b.view === 'thin_liquidity').map((b) => b.page), [0, 1])       // 120 rows: two pages
  eq(bodies.filter((b) => b.view === 'unusual_volume').map((b) => b.page), [0])          // zero: the view still answers with its zero
  for (const chain of CHAINS.map((c) => c.id)) assert(bodies.some((b) => b.chain === chain), chain)
  // Category leaders first, then the first page's categories, and only ones the select offers.
  eq(bodies.filter((b) => b.category).map((b) => b.category), ['Memes', 'Layer 1'])
  eq(bodies.filter((b) => b.provider !== 'auto').map((b) => b.provider), ['coinmarketcap', 'coingecko'])
  // The macro bar of the expanded context is a replay of an allowlisted shared table.
  const macro = keyed.filter((r) => r.fn === 'rest')
  eq(macro.map((r) => r.body), [marketMacroRequest().body])
  eq(demoRestRefusal(String(macro[0].body.table), String(macro[0].body.query)), null)
  assert(bodies.every((b) => b.watchlistOnly === false && b.search === '' && b.signalDirection === '' && b.limit === 50))
  assert(markets.length <= MARKETS_DEFAULT_PAGES + 2 + MARKET_SORTS.length * 4 + MARKET_VIEWS.length * 2 + CHAINS.length + MARKETS_CATEGORIES)
  // Degen: four pages of 180 tokens, every sort both ways, every bucket but the watchlist, and the chains seen.
  const dbodies = degen.map((r) => r.body as Any)
  eq(dbodies.filter((b) => Object.keys(b).length === 5 && b.sort === 'trending' && b.dir === 'desc' && !b.showExcluded).map((b) => b.page), [0, 1, 2, 3])
  for (const sort of DEGEN_SORTS) for (const dir of ['asc', 'desc']) assert(dbodies.some((b) => b.sort === sort && b.dir === dir), `degen ${sort} ${dir}`)
  assert(!dbodies.some((b) => b.bucket === 'watchlist'))
  for (const chain of ['solana', 'ethereum', 'base', 'bnb', 'sui']) assert(dbodies.some((b) => b.chain === chain), chain)
  assert(dbodies.some((b) => b.showExcluded === true))
  assert(dbodies.some((b) => b.riskMax === 30))
})

Deno.test('with no default screen the plan still covers the first pages and every option', () => {
  const plan = finalizePlan(marketsRequests(['solana']) as DemoRequest[])
  eq(plan.filter((r) => r.body.sort === 'market_cap' && r.body.dir === 'desc' && !r.body.view && !r.body.chain && r.body.provider === 'auto').length, MARKETS_DEFAULT_PAGES)
  eq(finalizePlan(degenRequests() as DemoRequest[]).filter((r) => Object.keys(r.body).length === 5 && r.body.sort === 'trending' && r.body.dir === 'desc' && !r.body.showExcluded).length, 6)
})

// ─── Degen ───────────────────────────────────────────────────────────────────

const token = (address: string, extra: Record<string, unknown> = {}) => ({
  chain: 'solana', token_address: address, symbol: `M${address}`, name: `Meme ${address}`, price_usd: 0.001, change_24h_pct: 5,
  volume_24h_usd: 100_000, liquidity_usd: 50_000, market_cap: 1_000_000, fdv: 1_000_000, discovery_reasons: ['trending'], source: 'dexscreener',
  listing_state: 'verified', liquidity_verified: true, is_trending: true, risk_score: 20, as_of: iso(-0.1), pair_created_at: iso(-48), ...extra,
})

Deno.test('the public Degen reader is intel-degen over the same rows, with no watchlist', async () => {
  const tokens = [token('a'), token('b', { volume_24h_usd: 200_000 }), token('c', { discovery_reasons: [] }), token('d', { source: null })]
  const db = fakeDb({ memecoin_latest_tokens: tokens, market_assets: [] })
  const reader = publicDegenReader(db)
  const read = await reader(degenScreenRequest().body, NOW)
  assert(read)
  // The token read is largest 24h volume first, as intel-degen reads it.
  eq(read!.body, degenScreenBody(degenScreenRows([tokens[1], tokens[0]]), degenScreenRequest().body, { catalogueContracts: new Set(), watchSet: null, now: NOW }))
  // deno-lint-ignore no-explicit-any
  eq((read!.body as any).rows.map((r: Any) => r.tokenAddress).sort(), ['a', 'b'], 'rows without reasons or a source are never shown')
  eq(await reader(degenScreenRequest({ bucket: 'watchlist' }).body, NOW), null)
  eq(await reader(degenScreenRequest({ sort: 'sideways' }).body, NOW), null)
  // A failed token read is not an empty screen.
  const broken = { ...fakeDb(), from: () => ({ select: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }) }) }
  eq(await publicDegenReader(broken)(degenScreenRequest().body, NOW), null)
})

Deno.test('intel-degen maps its rows with the shared read (source check)', async () => {
  const source = await Deno.readTextFile(new URL('../../intel-degen/index.ts', import.meta.url))
  assert(source.includes("from '../_shared/memecoin/degen-read.ts'"))
  assert(source.includes('tokensR = await readDegenTokens(admin)'))
  assert(source.includes('const all = degenScreenRows(tokensR?.data)'))
  assert(source.includes('const result = degenScreenBody(all, body, { catalogueContracts: catalogue, watchSet, now: Date.now() })'))
  assert(!source.includes('function rowOut('))
})
