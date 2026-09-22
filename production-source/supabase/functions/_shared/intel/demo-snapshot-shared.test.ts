// Tests for the demo snapshot's shared-data readers and REST replays: zero
// network calls, allowlist refusals, and parity with the live handlers.

import { assert, assertEquals as eq, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { buildDemoSnapshot, computeEntry, finalizePlan, type DemoRequest } from './demo-snapshot-builder.ts'
import {
  canonicalRestQuery, demoRequestKey, demoRestKey, demoRestRefusal, demoRpcKey, DEMO_REST_TABLES, DEMO_SHARED_RPCS,
  materializeRestQuery, relativeTimeValue, demoSnapshotKey,
} from './demo-snapshot-key.ts'
import {
  curatedNewsPage, dashboardRequests, defiBrowseRequest, macroRequests, narrativeDetailRequests, newsRequests,
  recentlyDiscoveredRequest, researchWorkspaceRequests,
} from './demo-snapshot-requests.ts'
import { planSharedRequests, publicDashboardReader, serviceRoleRestReplay, sharedFunctionReaders } from './demo-snapshot-shared.ts'
import { planDemoRequests } from './demo-snapshot-plan.ts'
import { cacheOnlyResearchReader } from './demo-snapshot-research.ts'
import { publicFeedRows, rankNarrativeSources, readPublicNarrativeDetail, readPublicNarratives } from './narrative-public-read.ts'
import { narrativeFeedResponse, narrativeFeedSummary } from './narrative-feed.ts'
import { dashboardSourceReads, publicDashboardSourceReads } from './dashboard-reads.ts'
import { assembleDashboardCore } from './dashboard-core.ts'
import { readDashboardPicture, readPublicDashboardPicture } from './dashboard-picture.ts'
import { defiBrowsePageData, readPublicDefiBrowse, vaultStable } from '../defi-public-browse.ts'
import { loadDefiBrowsePage } from '../defi-c2-cache.ts'
import { fakeDb, forbidNetwork, memoryStorage } from './demo-snapshot-fakes.test-helpers.ts'

const NOW = Date.parse('2026-09-22T21:00:00.000Z')
const env = () => undefined
const iso = (offsetHours: number) => new Date(NOW + offsetHours * 3_600_000).toISOString()

// ─── keys ────────────────────────────────────────────────────────────────────

Deno.test('REST keys: sorted decoded pairs, time windows as hour offsets, stable across the few minutes a page takes', () => {
  eq(relativeTimeValue(`gte.${iso(-168)}`, NOW), 'gte.@-168h')
  eq(relativeTimeValue(`gte.${new Date(NOW - 168 * 3_600_000 - 90_000).toISOString()}`, NOW), 'gte.@-168h')
  eq(canonicalRestQuery('b=2&a=1&a=0'), 'a=0\na=1\nb=2')
  const browser = `select=id%2Ctitle&published_at=gte.${encodeURIComponent(iso(-168))}&published_at=lte.${encodeURIComponent(iso(0))}&limit=12`
  eq(demoRestKey('intel_curated_news', browser, NOW + 20 * 60_000), demoRestKey('intel_curated_news', 'limit=12&published_at=gte.@-168h&published_at=lte.@0h&select=id,title'))
  // Materialising the tokens gives the window measured from the build clock.
  eq(new URLSearchParams(materializeRestQuery('published_at=gte.@-168h&limit=12', NOW)).getAll('published_at'), [`gte.${iso(-168)}`])
  // Table, function and RPC keys never collide.
  assert(demoRestKey('narrative_taxonomy', 'select=id').startsWith('rest-narrative_taxonomy.'))
  assert(demoRpcKey('intel_macro_news', { p_limit: 40 }).startsWith('rpc-intel_macro_news.'))
  eq(demoRequestKey({ fn: 'rpc', body: { name: 'intel_macro_news', args: { p_limit: '40' } } }), demoRpcKey('intel_macro_news', { p_limit: 40 }))
  eq(demoRequestKey({ fn: 'intel-dashboard', body: { section: 'core' } }), demoSnapshotKey('intel-dashboard', { section: 'core', orgId: 'x' }))
})

Deno.test('the REST allowlist refuses member data by table, filter, embed and column', () => {
  for (const table of ['watchlists', 'watchlist_items', 'investor_portfolios', 'investor_portfolio_holdings', 'intel_asset_theses', 'intel_alert_rules',
    'intel_alert_events', 'intel_briefs', 'research_artifacts', 'intel_research_threads', 'intel_trades', 'wallet_watch', 'intel_telegram_chats',
    'intel_agent_tokens', 'intel_notes', 'support_tickets', 'profiles', 'org_members', 'intel_user_profiles', 'tracked_sources', 'news_items',
    'intel_workspace_preferences', 'user_followed_narratives']) {
    assert(demoRestRefusal(table, 'select=id'), `${table} must be refused`)
  }
  eq(demoRestRefusal('market_assets', 'select=id'), 'table_not_allowlisted')
  eq(demoRestRefusal('intel_curated_news', 'select=id&org_id=eq.x'), 'owner_or_personal_filter')
  eq(demoRestRefusal('intel_curated_news', 'select=id&user_id=is.null'), 'owner_or_personal_filter')
  eq(demoRestRefusal('intel_curated_news', 'select=id&and=(created_by.eq.x)'), 'owner_or_personal_filter')
  eq(demoRestRefusal('intel_curated_news', 'select=id,profile:profiles(email)'), 'embedded_resource')
  eq(demoRestRefusal('intel_curated_news', 'select=id,user_id'), 'owner_or_personal_column')
  eq(demoRestRefusal('narrative_signals', 'select=avatar_url'), 'owner_or_personal_column')
  eq(demoRestRefusal('narrative_signals', 'select=*'), 'select_star')
  eq(demoRestRefusal('intel_macro_calendar', 'select=*'), null)
  for (const table of Object.keys(DEMO_REST_TABLES)) eq(demoRestRefusal(table, 'select=id'), null)
  eq([...DEMO_SHARED_RPCS].sort(), ['intel_current_regime', 'intel_macro_news'])
})

Deno.test('every planned REST request passes the allowlist', () => {
  const requests = [...macroRequests(), ...newsRequests(), recentlyDiscoveredRequest(), ...narrativeDetailRequests('gaming-tokens', '11111111-2222-4333-8444-555555555555')]
  const rest = requests.filter((r) => r.fn === 'rest')
  assert(rest.length >= 16)
  for (const r of rest) eq(demoRestRefusal(String(r.body.table), String(r.body.query)), null, `${r.body.table} ${r.body.query}`)
})

// ─── builder: rest, rpc, readers ─────────────────────────────────────────────

Deno.test('a REST entry replays the materialised query and stores rows and count; a personal table is refused before any read', async () => {
  const seen: string[] = []
  const rest = async (table: string, query: string) => { seen.push(`${table}?${query}`); return { rows: [{ id: 1 }], count: 7 } }
  const entry = await computeEntry(curatedNewsPage(0), { db: fakeDb(), storage: memoryStorage(), env, rest }, NOW)
  eq(entry, { status: 200, body: { rows: [{ id: 1 }], count: 7 } })
  assert(seen[0].includes(`published_at=gte.${encodeURIComponent(iso(-168))}`), seen[0])
  await assertRejects(() => computeEntry({ fn: 'rest', body: { table: 'watchlists', query: 'select=*' } }, { db: fakeDb(), storage: memoryStorage(), env, rest }, NOW), Error, 'rest_refused:personal_table')
  await assertRejects(() => computeEntry({ fn: 'rpc', body: { name: 'intel_list_briefs', args: {} } }, { db: fakeDb(), storage: memoryStorage(), env }, NOW), Error, 'rpc_refused')
  eq(seen.length, 1, 'the refused reads never reached the replay')
})

Deno.test('the service-role replay refuses before fetching and reads the exact count', async () => {
  const calls: { url: string; headers: Headers }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) })
    return new Response('[{"id":1}]', { status: 200, headers: { 'Content-Range': '0-0/42' } })
  }) as unknown as typeof fetch
  const replay = serviceRoleRestReplay('https://db.example/', 'service-key', fetchImpl)
  eq(await replay('intel_macro_indicators', 'select=*&order=metric_key.asc'), { rows: [{ id: 1 }], count: 42 })
  eq(calls[0].url, 'https://db.example/rest/v1/intel_macro_indicators?select=*&order=metric_key.asc')
  eq(calls[0].headers.get('Prefer'), 'count=exact')
  await assertRejects(() => replay('org_members', 'select=*'), Error, 'rest_refused')
  eq(calls.length, 1)
})

// ─── narratives ──────────────────────────────────────────────────────────────

const taxonomy = [
  { id: 'a', slug: 'ai-agents', name: 'AI agents', parent_category: 'ai', origin: 'seed', status: 'active', chains: ['base'] },
  { id: 'b', slug: 'ai-infra', name: 'AI infra', parent_category: 'ai', origin: 'seed', status: 'active', chains: [] },
  { id: 'c', slug: 'memes', name: 'Memes', parent_category: null, origin: 'seed', status: 'surfaced', chains: [] },
  { id: 'd', slug: 'retired', name: 'Retired', parent_category: null, origin: 'seed', status: 'archived', chains: [] },
]
const states = [
  { narrative_id: 'a', global_priority_score: 60, risk_score: 40, signal_class: 'bullish', clarity_labels: ['clear'] },
  { narrative_id: 'b', global_priority_score: 50, risk_score: 0, signal_class: 'bearish' },
  { narrative_id: 'c', global_priority_score: 55, risk_score: 80, signal_class: null },
]

Deno.test('the public feed is narrative_feed for a member with nothing personal: no boosts, same order and cap', () => {
  const rows = publicFeedRows(taxonomy, states)
  eq(rows.map((r) => r.slug), ['ai-agents', 'memes', 'ai-infra'])          // slot 1 in each category first, then final_rank
  eq(rows.map((r) => r.final_rank), [54, 43, 50])
  assert(rows.every((r) => r.is_followed === false && r.from_user_source === false && r.relevance_score === 0 && r.relevance_labels.length === 0))
  eq(rows[0].clarity_labels, ['clear'])
  eq(rows[1].clarity_labels, [])
  const five = publicFeedRows([1, 2, 3, 4, 5].map((i) => ({ id: `x${i}`, slug: `x${i}`, name: `X${i}`, parent_category: 'x', status: 'active' })),
    [1, 2, 3, 4, 5].map((i) => ({ narrative_id: `x${i}`, global_priority_score: 100 - i })))
  eq(five.map((r) => r.slug), ['x1', 'x2', 'x3', 'x4', 'x5'])
})

Deno.test('the feed summary is the one intel-narratives returns, and the handler uses the shared shape', async () => {
  const rows = publicFeedRows(taxonomy, states)
  eq(narrativeFeedResponse(rows), { narratives: rows, summary: narrativeFeedSummary(rows), count: 3 })
  eq(narrativeFeedSummary(rows), { heating_up: 0, early: 0, crowded: 0, cooling: 0, dormant: 0, bullish: 1, bearish: 1, high_risk: 1, followed: 0 })
  const source = await Deno.readTextFile(new URL('../../intel-narratives/index.ts', import.meta.url))
  assert(source.includes("import { narrativeFeedResponse } from '../_shared/intel/narrative-feed.ts'"))
  assert(/const \{ data: rows, error \} = await u\.rpc\('narrative_feed', \{ p_org_id: orgId, p_limit: limit \}\)\s+if \(error\) return json\(\{ error: error\.message \}, 400\)\s+\/\/[^\n]*\n\s+return json\(narrativeFeedResponse\(rows\)\)/.test(source))
})

Deno.test('the detail follows narrative_detail: ranked sources, drivers, chatter preference, no personal data', async () => {
  const signals = [
    { narrative_id: 'a', source_url: 'https://x/1', relevance_score: 90, source_quality_score: 80, observed_at: iso(-1), signal_kind: 'news', provider: 'rss', title: 'one' },
    { narrative_id: 'a', source_url: 'https://x/2', relevance_score: 20, source_quality_score: 99, observed_at: iso(-1), signal_kind: 'news', provider: 'rss', title: 'low relevance' },
    { narrative_id: 'a', source_url: null, relevance_score: 99, observed_at: iso(-1), signal_kind: 'news', provider: 'rss', title: 'no url' },
    { narrative_id: 'a', source_url: 'https://x/3', relevance_score: null, source_quality_score: null, observed_at: null, fetched_at: null, signal_kind: 'news', provider: 'rss', title: 'no clock' },
  ]
  const ranked = rankNarrativeSources(signals, NOW)
  eq(ranked.map((s) => s.title), ['no clock', 'one'])
  eq(Object.keys(ranked[1]).sort(), ['author_handle', 'bias', 'domain', 'observed_at', 'provider', 'relevance_score', 'scoring_role', 'signal_kind', 'snippet', 'source_quality_score', 'title', 'url'])
  const db = fakeDb({
    narrative_taxonomy: [{ ...taxonomy[0], membership_rules: { secret: true } }],
    narrative_state: [{ ...states[0], debug: { internal: 1 } }],
    narrative_source_drivers: [{ id: 1, narrative_id: 'a', title: 'driver', last_seen_at: iso(-2) }],
    narrative_signals: [...signals, { narrative_id: 'a', signal_kind: 'social_chatter', provider: 'grok', strength: 70, bias: 'bullish', raw: { why: 'x' }, fetched_at: iso(-3) }],
    intel_shared_artifacts: [],
  })
  const detail = await readPublicNarrativeDetail(db, 'ai-agents', NOW)
  assert(detail)
  eq(detail!.taxonomy.membership_rules, undefined)
  eq(detail!.state.debug, undefined)
  eq(detail!.drivers.length, 1)
  eq(detail!.chatter, { strength: 70, bias: 'bullish', raw: { why: 'x' } })
  eq(detail!.is_followed, false)
  eq(detail!.briefState, 'empty')
  eq(await readPublicNarrativeDetail(db, 'unknown', NOW), null)
  eq(await readPublicNarratives(db, { mode: 'debug', slug: 'ai-agents' }, NOW), null)
})

// ─── dashboard ───────────────────────────────────────────────────────────────

function recordingDb(rows: Record<string, unknown[] | null>) {
  const calls: { name: string; ops: unknown[][] }[] = []
  const query = (name: string) => {
    const call = { name, ops: [] as unknown[][] }
    calls.push(call)
    // deno-lint-ignore no-explicit-any
    const q: any = new Proxy({ then: (yes: any) => Promise.resolve({ data: name in rows ? rows[name] : [], error: null }).then(yes) }, {
      // deno-lint-ignore no-explicit-any
      get: (t: any, p: string) => (p === 'then' ? t.then : (...a: unknown[]) => { call.ops.push([p, ...a]); return q }),
    })
    return q
  }
  return { calls, db: { from: query, rpc: (name: string) => query(name) } }
}

Deno.test('the public dashboard reads only the four shared sources, exactly as the live reads run them', async () => {
  const live = recordingDb({}), pub = recordingDb({})
  await Promise.all(Object.values(dashboardSourceReads(live.db, 'org', 'owner', 'all', null).sources))
  await Promise.all(Object.values(publicDashboardSourceReads(pub.db).sources))
  const shared = ['intel_global_news', 'exchange_latest_tickers', 'exchange_latest_market_signals', 'intel_curated_news']
  eq(pub.calls.map((c) => c.name), shared)
  const strip = (ops: unknown[][]) => JSON.stringify(ops).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, 'T')
  for (const name of shared) eq(strip(pub.calls.find((c) => c.name === name)!.ops), strip(live.calls.find((c) => c.name === name)!.ops), name)
})

Deno.test('the core body is the live assembly over the shared rows, with every personal section empty', async () => {
  const rows = {
    intel_global_news: [{ id: 1, title: 'Bitcoin ETF sees record inflows', url: 'https://n/1', source_name: 'Wire', sentiment: 'bullish', published_at: iso(-2), created_at: iso(-2), chains: ['bitcoin'], entity_symbol: 'BTC' }],
    exchange_latest_tickers: [{ normalized_symbol: 'BTC', provider: 'binance', provider_symbol: 'BTCUSDT', price_change_pct_24h: 3.2, volume_quote_24h: 1e9, spread_pct: 0.01, as_of: iso(-0.1) }],
    exchange_latest_market_signals: [],
    intel_curated_news: [],
    intel_briefs: null, // maybeSingle: a member with no brief
  }
  const live = recordingDb(rows), pub = recordingDb(rows)
  const common = { scope: 'all', chain: null, section: 'core' }
  const liveBody = await assembleDashboardCore({ supabase: live.db, accessAdmin: live.db, batch: dashboardSourceReads(live.db, 'org', 'owner', 'all', null), orgId: 'org', ...common })
  const publicBody = (await publicDashboardReader(pub.db)({ ...common }, NOW))!.body as Record<string, unknown>
  const pick = (b: Record<string, unknown>) => JSON.parse(JSON.stringify({ ...b, generated_at: null, read_states: null, what_changed_context: null, figure_provenance: null }))
  eq(pick(publicBody), pick(liveBody))
  eq((publicBody.market_movers as unknown[]).length, 1)
  eq(publicBody.alerts, []); eq(publicBody.latest_brief, null); eq(publicBody.recent_research, []); eq(publicBody.for_you, [])
  // intel-dashboard hands the same assembly its reads and its live-only callbacks.
  const source = await Deno.readTextFile(new URL('../../intel-dashboard/index.ts', import.meta.url))
  assert(source.includes("import {assembleDashboardCore} from '../_shared/intel/dashboard-core.ts'"))
  assert(/const batch=dashboardSourceReads\(supabase,orgId,auth\.user\.id,scope,chain\)[\s\S]{0,200}const body=await assembleDashboardCore\(\{\s+supabase, accessAdmin, batch, orgId, scope, chain, section, beKey: Deno\.env\.get\('BIRDEYE_API_KEY'\)/.test(source))
  assert(source.indexOf('requireIntelAccess(req,createClient,accessAdmin,orgId)') < source.indexOf('assembleDashboardCore({'))
  eq(await publicDashboardReader(pub.db)({ scope: 'chain', chain: 'base', section: 'core' }, NOW), null)
})

Deno.test('the public picture equals the live picture for a member with no flows', async () => {
  const db = fakeDb({ market_macro_available: [{ id: 1, as_of: iso(-1), total_market_cap_usd: 1 }] })
  const live = await readDashboardPicture(db, 'org', 'owner', new Date(NOW))
  const pub = await readPublicDashboardPicture(db, new Date(NOW))
  const clockless = (p: Record<string, unknown>) => JSON.parse(JSON.stringify(p, (k, v) => (k === 'durationMs' ? 0 : v)))
  eq(clockless(pub.picture), clockless(live.picture))
})

// ─── DeFi ────────────────────────────────────────────────────────────────────

Deno.test('the public DeFi page goes through the live validation and mapping (defiBrowseResponse)', async () => {
  const vault = (address: string, tvl: number | null, at: string, id: number, extra: Record<string, unknown> = {}) =>
    ({ id, org_id: null, vault_address: address, vault_name: address.toUpperCase(), product_type: 'lp', tvl_usd: tvl, apy: 0.1, snapshot_at: at, token_a: 'SOL', token_b: 'USDC', ...extra })
  const db = fakeDb({ kamino_vault_snapshots: [
    vault('a', 100, iso(-5), 1), vault('a', 300, iso(-1), 2), vault('b', 200, iso(-1), 3), vault('c', null, iso(-1), 4),
    vault('old', 999, iso(-24 * 8), 5), { ...vault('private', 5000, iso(-1), 6), org_id: 'someone' },
  ] })
  const read = await readPublicDefiBrowse(db, defiBrowseRequest('vaults', 0).body, NOW)
  // deno-lint-ignore no-explicit-any
  const body = read!.body as any
  eq(body.rows.map((r: { address: string }) => r.address), ['a', 'b', 'c'])
  eq(body.rows[0].tvl_usd, 300)
  eq(body.total, 3); eq(body.summary.count, 3); eq(body.summary.tvl, 500)
  eq(body.chain, 'solana'); eq(body.view, 'vaults'); eq(body.status, 'ok')
  // The live function maps the same page data to the same rows.
  eq(defiBrowsePageData('solana', 'vaults', [], 0, 50).summary, { count: 0, tvl: null, topApy: null, averageUtilization: null, weightedApy: null })
  const liveDb = { rpc: async () => ({ data: { ...defiBrowsePageData('solana', 'vaults', [{ vault_address: 'a', vault_name: 'A', tvl_usd: 1, product_type: 'lp' }], 0, 50) }, error: null }) }
  const liveRows = await loadDefiBrowsePage(liveDb, 'org', { chain: 'solana', view: 'vaults' })
  eq(liveRows.rows[0].address, 'a'); eq(liveRows.status, 'ok')
  // Any other query is not part of the demo.
  eq(await readPublicDefiBrowse(db, { ...defiBrowseRequest('vaults', 0).body, search: 'sol' }, NOW), null)
  eq(vaultStable({ raw_stable: 'true' }), true)
  eq(vaultStable({ token_a_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', product_type: 'single', token_b_mint: null }), true)
  eq(vaultStable({ token_a_mint: 'So11111111111111111111111111111111111111112', token_b_mint: 'x' }), null)
})

// ─── the whole plan, zero network ────────────────────────────────────────────

Deno.test('the shared plan and a whole build over it make no network call and read no personal table', async () => {
  const net = forbidNetwork()
  try {
    const db = fakeDb({
      narrative_taxonomy: taxonomy, narrative_state: states, narrative_score_snapshots: [],
      intel_global_news: [], exchange_latest_tickers: [], exchange_latest_market_signals: [], intel_curated_news: [], market_macro_available: [],
      kamino_vault_snapshots: [], kamino_market_snapshots: [],
    })
    const touched: string[] = []
    const from = db.from
    db.from = (table: string) => { touched.push(table); return from(table) }
    const plan = await planSharedRequests(db, NOW)
    const keys = finalizePlan(plan as DemoRequest[]).map((r) => r.key)
    eq(new Set(keys).size, keys.length)
    assert(plan.length < 200, `${plan.length} shared requests`)
    const fns = new Set(plan.map((r) => r.fn))
    for (const fn of ['intel-dashboard', 'intel-narratives', 'intel-defi-browse', 'intel-research', 'rest', 'rpc']) assert(fns.has(fn), fn)
    eq(plan.filter((r) => r.fn === 'intel-narratives' && r.body.mode === 'detail').length, 3)
    const restCalls: string[] = []
    const storage = memoryStorage()
    let result = await buildDemoSnapshot({
      db, storage, env, now: () => NOW,
      research: cacheOnlyResearchReader(db),
      rest: async (table) => { restCalls.push(table); return { rows: [], count: 0 } },
      functions: sharedFunctionReaders(db),
      planner: (d, now) => planDemoRequests(d, now),
    }, { trigger: 'cron' })
    for (let hops = 0; result.status === 'partial' && hops < 200; hops++) result = await buildDemoSnapshot({
      db, storage, env, now: () => NOW, research: cacheOnlyResearchReader(db),
      rest: async (table) => { restCalls.push(table); return { rows: [], count: 0 } }, functions: sharedFunctionReaders(db),
      planner: (d, now) => planDemoRequests(d, now),
    }, { trigger: 'cron', cursor: result.cursor })
    eq(result.status, 'complete')
    eq(result.errors.filter((e) => e.key !== 'prune'), [])
    eq(net.calls, [], 'no network call of any kind')
    assert(restCalls.length >= 10)
    for (const table of [...touched, ...restCalls]) assert(!/watchlist|portfolio|^profiles$|user_profiles|org_members|alert|brief|research_artifacts|trade|wallet|telegram|thes[ie]s|followed|large_transfer/.test(table), `touched ${table}`)
    const written = [...storage.files.keys()].filter((p) => p.includes('/rest-') || p.includes('/intel-dashboard.') || p.includes('/intel-narratives.'))
    assert(written.length > 10, `${written.length} shared entries written`)
    eq(db.writes.filter((w) => w.table !== 'intel_demo_snapshot_runs'), [], 'the build writes nothing but its run rows')
  } finally { net.restore() }
})

Deno.test('the market research reads come from the shared cache pass only', async () => {
  const calls: unknown[][] = []
  const snapshot = (async (...args: unknown[]) => { calls.push(args); return { state: 'cached', data: { rows: [{ id: 1 }] }, provenance: { fetchedAt: iso(-1) } } }) as never
  const reader = cacheOnlyResearchReader(fakeDb(), snapshot)
  const [global, listings] = researchWorkspaceRequests()
  assert(await reader('global', (global.body as { params: Record<string, unknown> }).params))
  assert(await reader('listings', (listings.body as { params: Record<string, unknown> }).params))
  for (const args of calls) { eq(args[3], null, 'no user'); eq(args[7], 'shared-cache') }
  const empty = cacheOnlyResearchReader(fakeDb(), (async () => ({ state: 'unavailable', data: { rows: [] }, provenance: null })) as never)
  eq(await empty('global', {}), null)
  eq(await reader('quotes', { id: '1' }), null)
  eq(dashboardRequests().length, 2)
})
