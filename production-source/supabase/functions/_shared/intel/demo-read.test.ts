import { assertEquals, assertRejects, assertThrows } from 'jsr:@std/assert@1'
import { answerDemoRead, DEMO_UNTRACKED, DemoReadRefusal, parseDemoRead, type DemoReadDeps, type Identity } from './demo-read.ts'
import { handleDemoRead, type HandlerDeps } from '../../intel-demo-read/handler.ts'

// deno-lint-ignore no-explicit-any
type Any = any

const TRACKED = new Set(['coinmarketcap:1', 'coinmarketcap:1027', 'coinmarketcap:39306', 'coingecko:bitcoin'])
const ROWS: Record<string, Any> = {
  'coinmarketcap:1': { source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', normalized_symbol: 'BTC', name: 'Bitcoin' },
  'coinmarketcap:1027': { source_provider: 'coinmarketcap', provider_id: '1027', symbol: 'ETH', normalized_symbol: 'ETH', name: 'Ethereum' },
  'coinmarketcap:39306': { source_provider: 'coinmarketcap', provider_id: '39306', symbol: 'SGOVON', normalized_symbol: 'SGOVON', name: 'iShares 0-3 Month Treasury Bond Tokenized ETF (Ondo)' },
  'coinmarketcap:77777': { source_provider: 'coinmarketcap', provider_id: '77777', symbol: 'RAND', normalized_symbol: 'RAND', name: 'Random new token' },
}

function fakes(overrides: Partial<DemoReadDeps> = {}) {
  const calls: string[] = []
  const deps: DemoReadDeps = {
    tracked: (ids: Identity[]) => { calls.push('tracked'); return Promise.resolve(new Set(ids.map((i) => `${i.sourceProvider}:${i.providerId}`).filter((k) => TRACKED.has(k)))) },
    suggest: (q) => {
      calls.push('suggest')
      const matches = /sgov/i.test(q)
        ? [{ sourceProvider: 'coinmarketcap', providerId: '39306', symbol: 'SGOVON', match: 'symbol_exact', href: '/intel/markets/SGOVON?provider=coinmarketcap&id=39306' }]
        : /btc|0x/i.test(q) ? [
          { sourceProvider: 'coinmarketcap', providerId: '1', symbol: 'BTC', match: 'symbol_exact' },
          { sourceProvider: 'coinmarketcap', providerId: '77777', symbol: 'BTCX', match: 'symbol_prefix' },
          { sourceProvider: 'contract', providerId: 'ethereum:0xabc', symbol: null, match: 'contract' },
        ] : []
      return Promise.resolve({ q, limit: 20, error: null, matches })
    },
    screen: (query) => { calls.push('screen'); return Promise.resolve({ rows: /btc/i.test(String(query.search)) ? [{ symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }] : [], total: 1 }) },
    resolve: (symbol, identity) => {
      calls.push('resolve')
      if (identity) return Promise.resolve({ data: ROWS[`${identity.sourceProvider}:${identity.providerId}`] || null, error: null, ambiguous: false })
      const found = Object.values(ROWS).find((row) => row.normalized_symbol === symbol.toUpperCase())
      return Promise.resolve({ data: found || null, error: null, ambiguous: false })
    },
    detail: (read, asset) => { calls.push(`detail:${read.mode}`); return Promise.resolve({ status: 200, body: { detail: true, symbol: asset.symbol, providerId: asset.provider_id } }) },
    history: (_read, asset) => { calls.push('history'); return Promise.resolve({ status: 200, body: { history: { points: [] }, identity: { providerId: asset.provider_id } } }) },
    facts: (identity) => { calls.push('facts'); return Promise.resolve({ status: 200, body: { asset: identity } }) },
    cohorts: () => { calls.push('cohorts'); return Promise.resolve({ cohorts: [] }) },
    profile: (identity) => { calls.push('profile'); return Promise.resolve({ profile: { provider_id: identity.providerId }, state: 'fresh' }) },
    capture: (body) => { calls.push(`capture:${body.view}`); return Promise.resolve({ status: 200, body: { view: body.view } }) },
    venue: (canonicalKey) => { calls.push('venue'); return Promise.resolve({ canonicalKey }) },
    canonicalKeys: (asset) => [`market:${asset.source_provider}:${asset.provider_id}`, asset.provider_id === '1' ? 'bip122:native:BTC' : ''].filter(Boolean),
    news: (table) => { calls.push(`news:${table}`); return Promise.resolve([{ id: 1, title: 'Bitcoin headline' }]) },
    resolveIdentity: (cmcId) => { calls.push('resolveIdentity'); return Promise.resolve({ status: 'resolved', query: `cmc:${cmcId}`, identity: { providerId: cmcId } }) },
    evidenceSubjects: (asset) => (asset.provider_id === '39306' ? ['eip155:1:0x8de5d49725550f7b318b2fa0f1b1f118e98e8d0f'] : []),
    evidence: (read) => { calls.push('evidence'); return Promise.resolve({ status: 200, body: { observations: [], hasMore: false, nextCursor: null, subjects: [read.subject] } }) },
    ...overrides,
  }
  return { deps, calls }
}

const answer = (body: unknown, deps: DemoReadDeps) => answerDemoRead(parseDemoRead(body), deps)

Deno.test('a tracked asset opens: detail, candles, quote, history, facts, profile, capture and venue answer', async () => {
  const { deps, calls } = fakes()
  const detail = await answer({ read: 'detail', symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1', timeframe: '7D' }, deps)
  assertEquals(detail.status, 200)
  assertEquals(detail.body.symbol, 'BTC')
  assertEquals((await answer({ read: 'detail', mode: 'candles', symbol: 'ETH', sourceProvider: 'coinmarketcap', providerId: 1027, timeframe: '1M', interval: '1D', lookbackBars: 50 }, deps)).status, 200)
  assertEquals((await answer({ read: 'detail', mode: 'quote', sourceProvider: 'coinmarketcap', providerId: '39306' }, deps)).status, 200)
  assertEquals((await answer({ read: 'history', sourceProvider: 'coinmarketcap', providerId: '1', range: '30d' }, deps)).status, 200)
  assertEquals((await answer({ read: 'facts', sourceProvider: 'coinmarketcap', providerId: '1', days: 90 }, deps)).status, 200)
  assertEquals((await answer({ read: 'profile', sourceProvider: 'coingecko', providerId: 'bitcoin' }, deps)).status, 200)
  assertEquals((await answer({ read: 'capture', view: 'rwa_token_depth', cryptoId: '39306' }, deps)).status, 200)
  assertEquals((await answer({ read: 'capture', view: 'attention', providerId: 1, hours: 24 }, deps)).status, 200)
  assertEquals((await answer({ read: 'venue', canonicalKey: 'bip122:native:BTC', sourceProvider: 'coinmarketcap', providerId: '1' }, deps)).status, 200)
  assertEquals((await answer({ read: 'resolve', query: 'cmc:1027' }, deps)).body.status, 'resolved')
  const evidence = await answer({ read: 'evidence', subject: 'eip155:1:0x8de5d49725550f7b318b2fa0f1b1f118e98e8d0f', from: 1, to: 2, limit: 100, metrics: ['liquidity_event_usd', 'swap_event_usd'], sourceProvider: 'coinmarketcap', providerId: '39306' }, deps)
  assertEquals(evidence.body.hasMore, false)
  // A bare ticker resolves, and only then is its identity checked.
  assertEquals((await answer({ read: 'detail', symbol: 'btc' }, deps)).body.providerId, '1')
  assertEquals(calls.filter((c) => c.startsWith('detail')), ['detail:full', 'detail:candles', 'detail:quote', 'detail:full'])
})

Deno.test('an untracked identity is refused on the server with 403 demo_untracked, before any read of its own', async () => {
  const { deps, calls } = fakes()
  for (const body of [
    { read: 'detail', symbol: 'RAND', sourceProvider: 'coinmarketcap', providerId: '77777' },
    { read: 'history', sourceProvider: 'coinmarketcap', providerId: '77777' },
    { read: 'facts', sourceProvider: 'coinmarketcap', providerId: '77777' },
    { read: 'profile', sourceProvider: 'coinmarketcap', providerId: '77777' },
    { read: 'capture', view: 'rwa_token_depth', cryptoId: '77777' },
  ]) {
    const refused = await answer(body, deps)
    assertEquals(refused.status, 403)
    assertEquals(refused.body.error, DEMO_UNTRACKED)
  }
  assertEquals(calls.filter((c) => c !== 'tracked'), [])
  // A bare symbol that resolves to an untracked row, or to nothing, is refused too.
  assertEquals((await answer({ read: 'detail', symbol: 'RAND' }, deps)).status, 403)
  assertEquals((await answer({ read: 'detail', symbol: 'NOPE' }, deps)).status, 403)
  // A pasted contract or an on-demand row is never a tracked identity.
  assertThrows(() => parseDemoRead({ read: 'detail', symbol: 'X', sourceProvider: 'contract', providerId: 'ethereum:0xdead' }), DemoReadRefusal, DEMO_UNTRACKED)
  assertThrows(() => parseDemoRead({ read: 'detail', symbol: 'X', sourceProvider: 'on_demand', providerId: 'solana:abc' }), DemoReadRefusal, DEMO_UNTRACKED)
  // Identity resolution: a tracked CoinMarketCap id only; a pasted contract never.
  assertEquals((await answer({ read: 'resolve', query: 'cmc:77777' }, deps)).status, 403)
  assertThrows(() => parseDemoRead({ read: 'resolve', query: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }), DemoReadRefusal, DEMO_UNTRACKED)
  // Contract evidence for a subject the tracked asset's page could not chart is refused.
  assertEquals((await answer({ read: 'evidence', subject: 'eip155:1:0x1111111111111111111111111111111111111111', from: 1, to: 2, sourceProvider: 'coinmarketcap', providerId: '39306' }, deps)).status, 403)
  // A venue key the tracked asset's page could not name is refused.
  assertEquals((await answer({ read: 'venue', canonicalKey: 'eip155:1:0xdeadbeef', sourceProvider: 'coinmarketcap', providerId: '1' }, deps)).status, 403)
})

Deno.test('suggestions keep tracked assets only and drop a random contract offer; an empty search says why', async () => {
  const { deps } = fakes()
  const found = await answer({ read: 'suggest', q: 'BTC', limit: 8 }, deps)
  assertEquals(found.status, 200)
  assertEquals(found.body.matches.map((m: Any) => m.providerId), ['1'])
  assertEquals(found.body.demoReason, undefined)
  const none = await answer({ read: 'suggest', q: '0xabc' }, fakes({ suggest: (q) => Promise.resolve({ q, limit: 20, error: null, matches: [{ sourceProvider: 'contract', providerId: 'ethereum:0xabc' }] }) }).deps)
  assertEquals(none.body.matches, [])
  assertEquals(none.body.demoReason, DEMO_UNTRACKED)
  // A screen search keeps its rows; tracked matches already on screen are not repeated.
  const screen = await answer({ read: 'screen', query: { search: 'BTC', provider: 'auto', sort: 'market_cap', dir: 'desc', page: 0, limit: 10, watchlistOnly: false } }, deps)
  assertEquals(screen.body.rows.length, 1)
  assertEquals(screen.body.demoSuggestions, [])
  assertEquals(screen.body.demoReason, undefined)
  // A tracked asset outside the screen's catalogue is still found, and is not "untracked".
  const outside = await answer({ read: 'screen', query: { search: 'SGOVon' } }, deps)
  assertEquals(outside.body.rows, [])
  assertEquals(outside.body.demoSuggestions.map((m: Any) => m.providerId), ['39306'])
  assertEquals(outside.body.demoReason, undefined)
  // Only text that names no tracked asset at all is "untracked".
  const empty = await answer({ read: 'screen', query: { search: 'zzzz' } }, deps)
  assertEquals(empty.body.demoReason, DEMO_UNTRACKED)
})

Deno.test('requests are rebuilt from allowed fields: extras, org ids, bad values and unknown reads are refused', () => {
  const refused = (body: unknown, code: string) => assertThrows(() => parseDemoRead(body), DemoReadRefusal, code)
  refused({ read: 'detail', symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1', orgId: 'x' }, 'invalid_request')
  refused({ read: 'suggest', q: 'BTC', token: 'x' }, 'invalid_request')
  refused({ read: 'screen', query: { search: '' } }, 'invalid_search')
  refused({ read: 'screen', query: { search: 'BTC', watchlistOnly: true } }, 'invalid_request')
  refused({ read: 'screen', query: { search: 'BTC', sort: 'drop table' } }, 'invalid_sort')
  refused({ read: 'detail', symbol: 'BTC', timeframe: '9Y' }, 'invalid_chart_range')
  refused({ read: 'detail', symbol: 'BTC', lookbackBars: 5000 }, 'invalid_lookback')
  refused({ read: 'generate', q: 'x' }, 'invalid_read')
  refused({ read: 'news', table: 'news_items', terms: ['title.ilike.%x%'] }, 'invalid_table')
  refused({ read: 'news', table: 'intel_global_news', terms: ['org_id.eq.1'] }, 'invalid_terms')
  refused({ read: 'news', table: 'intel_curated_news', terms: ['tokens.cs.{"BTC"},org_id.eq.1'] }, 'invalid_terms')
  refused({ read: 'capture', view: 'rwa_depth' }, 'invalid_view')
  refused([], 'invalid_request')
  // The accepted news terms are the page's own.
  assertEquals(parseDemoRead({ read: 'news', table: 'intel_curated_news', terms: ['tokens.cs.{"BTC"}', 'tokens.cs.{"Bitcoin"}', 'chains.cs.{bitcoin}'] }).read, 'news')
  assertEquals(parseDemoRead({ read: 'news', table: 'intel_global_news', terms: ['title.ilike.%Bitcoin%', 'entity_symbol.eq."BTC"'] }).read, 'news')
})

Deno.test('a failing allowlist read is an error, never an open door', async () => {
  const { deps } = fakes({ tracked: () => Promise.reject(new Error('tracked_read_failed')) })
  await assertRejects(() => answer({ read: 'detail', symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }, deps))
})

function handlerDeps(reads: DemoReadDeps, limit: HandlerDeps['limit'] = () => Promise.resolve({ ok: true, retryAfter: 0 })): HandlerDeps {
  return { reads, limit, ipKey: () => Promise.resolve('ip:test:demo-read'), secrets: () => ['service-role-secret-value'] }
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request('https://x.supabase.co/functions/v1/intel-demo-read', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

Deno.test('handler: tracked 200, untracked 403, bad body 400, oversize 413, rate limit 429, GET 405', async () => {
  const { deps } = fakes()
  const ok = await handleDemoRead(post({ read: 'detail', symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }), handlerDeps(deps))
  assertEquals(ok.status, 200)
  assertEquals(ok.headers.get('Cache-Control'), 'no-store')
  assertEquals(ok.headers.get('Access-Control-Allow-Origin'), '*')
  const refused = await handleDemoRead(post({ read: 'detail', symbol: 'RAND', sourceProvider: 'coinmarketcap', providerId: '77777' }), handlerDeps(deps))
  assertEquals(refused.status, 403)
  assertEquals((await refused.json()).code, DEMO_UNTRACKED)
  assertEquals((await handleDemoRead(post('{not json'), handlerDeps(deps))).status, 400)
  assertEquals((await handleDemoRead(post({ read: 'suggest', q: 'x'.repeat(5000) }), handlerDeps(deps))).status, 413)
  assertEquals((await handleDemoRead(new Request('https://x/functions/v1/intel-demo-read'), handlerDeps(deps))).status, 405)
  let count = 0
  const limited = handlerDeps(deps, (_key, limit) => Promise.resolve(++count > limit ? { ok: false, retryAfter: 42 } : { ok: true, retryAfter: 0 }))
  let last: Response | null = null
  for (let i = 0; i < 61; i++) last = await handleDemoRead(post({ read: 'suggest', q: 'BTC' }), limited)
  assertEquals(last!.status, 429)
  assertEquals(last!.headers.get('Retry-After'), '42')
})

Deno.test('handler: a reader failure is a 503 with no secret in it', async () => {
  const { deps } = fakes({ detail: () => Promise.reject(new Error('boom service-role-secret-value')) })
  const failed = await handleDemoRead(post({ read: 'detail', symbol: 'BTC', sourceProvider: 'coinmarketcap', providerId: '1' }), handlerDeps(deps))
  assertEquals(failed.status, 503)
  const text = await failed.text()
  assertEquals(text.includes('service-role-secret-value'), false)
})
