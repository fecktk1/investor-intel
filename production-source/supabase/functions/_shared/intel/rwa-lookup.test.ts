import { assert, assertEquals, assertFalse, assertThrows } from 'jsr:@std/assert@1'
import { lookupRwa, parseLookupQuery, parseResearchRequest, reproduceLine, researchRwa, scrubSecrets, trimRaw, IP_LIVE_LIMIT_REASON, LOOKUP_LIVE_RATE, LOOKUP_RATE } from './rwa-lookup.ts'
import { researchParams } from './research-service.ts'
import { handleLookup, type HandlerDeps } from '../../intel-rwa-lookup/handler.ts'
import type { FreeRwaPlan } from './rwa-free-read.ts'

// The public lookup, asserted against the mechanism that holds each property:
// validation, the per-IP limits, cache first, the failed-live fallback with its
// age, and that no key can ever leave in a body.

const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const KEY = 'cmc-secret-key-0123456789abcdef'

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

/** Just enough PostgREST for the reads the lookup makes. */
function fakeDb(tables: Record<string, Row[]>, opts: { rpcLog?: Row[]; failTables?: string[] } = {}) {
  const rpcLog = opts.rpcLog ?? []
  const like = (pattern: string, value: unknown) => {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}$`, 'i')
    return value != null && re.test(String(value))
  }
  return {
    rpcLog,
    from(table: string) {
      let rows = [...(tables[table] || [])]
      let head = false, count = false, limit = Infinity
      const q = {
        select(_c: string, o?: { count?: string; head?: boolean }) { head = !!o?.head; count = !!o?.count; return q },
        eq(k: string, v: unknown) { rows = rows.filter((r) => String(r[k]) === String(v)); return q },
        ilike(k: string, v: string) { rows = rows.filter((r) => like(v, r[k])); return q },
        gte(k: string, v: string) { rows = rows.filter((r) => Date.parse(r[k]) >= Date.parse(v)); return q },
        lte(k: string, v: string) { rows = rows.filter((r) => Date.parse(r[k]) <= Date.parse(v)); return q },
        order(k: string, o: { ascending: boolean }) {
          rows.sort((a, b) => {
            const x = a[k], y = b[k]
            if (x == null) return 1; if (y == null) return -1
            const cmp = typeof x === 'number' ? x - y : String(x).localeCompare(String(y))
            return o.ascending ? cmp : -cmp
          }); return q
        },
        limit(n: number) { limit = n; return q },
        then(resolve: (v: unknown) => void) {
          if (opts.failTables?.includes(table)) return resolve({ data: null, error: { message: 'down' } })
          resolve(head ? { data: null, count: count ? rows.length : null, error: null } : { data: rows.slice(0, limit), error: null })
        },
      }
      return q
    },
    rpc(name: string, args: Row) {
      rpcLog.push({ name, args })
      if (name === 'intel_rwa_lookup_remember') {
        const list = tables.intel_rwa_lookup_last_good ||= []
        const existing = list.find((r) => String(r.rwa_id) === String(args.p_rwa_id))
        if (existing && Date.parse(existing.fetched_at) >= Date.parse(args.p_fetched_at)) return Promise.resolve({ data: false, error: null })
        const row = { rwa_id: args.p_rwa_id, payload: args.p_payload, fetched_at: args.p_fetched_at, http_status: args.p_http_status, credit_count: args.p_credit_count, served_as: args.p_served_as }
        if (existing) Object.assign(existing, row); else list.push(row)
        return Promise.resolve({ data: true, error: null })
      }
      if (name === 'intel_rwa_lookup_research_remember') {
        const list = tables.intel_rwa_lookup_research_last_good ||= []
        const existing = list.find((r) => r.capability === args.p_capability && r.params_key === args.p_params_key)
        if (existing && Date.parse(existing.fetched_at) >= Date.parse(args.p_fetched_at)) return Promise.resolve({ data: false, error: null })
        const row = { capability: args.p_capability, params_key: args.p_params_key, body: args.p_body, fetched_at: args.p_fetched_at }
        if (existing) Object.assign(existing, row); else list.push(row)
        return Promise.resolve({ data: true, error: null })
      }
      return Promise.resolve({ data: null, error: { message: 'unexpected_rpc' } })
    },
  }
}

const NVDA_BODY = {
  status: { error_code: 0, credit_count: 1 },
  data: { rwa_assets: [{
    rwa_id: 2, name: 'Nvidia Corp', slug: 'nvidia', symbol: 'NVDA',
    quotes: [{ symbol: 'USD', last_updated: '2026-10-05T11:50:00.000Z', tokenized_market_cap: 137247587.75, tokenized_volume_24h: 162232707.33, average_tokenized_price: 228.42 }],
    tokens: [
      { name: 'NVIDIA xStock', symbol: 'NVDAX', crypto_id: 36992, issuer_name: 'Backed Assets', price: 228.68, market_cap: 42015407.81, volume_24h: 38764552.79 },
      { name: 'NVIDIA Derivatives', symbol: 'NVDA', crypto_id: 38153, issuer_name: 'NA', price: 228.37, market_cap: 0, volume_24h: 652580.58 },
    ],
  }] },
}

function tables(): Record<string, Row[]> {
  return {
    intel_rwa_asset_profiles: [
      { rwa_id: 2, slug: 'nvidia', symbol: 'NVDA', name: 'Nvidia Corp', asset_type: 'stock', rwa_rank: 1, has_tokens: true, provider_capability: 'rwaInfo', captured_at: '2026-09-30T03:29:00.000Z', provider_fetched_at: '2026-09-30T03:28:00.000Z', description: 'long prose' },
      { rwa_id: 242, slug: 'sgov', symbol: 'SGOV', name: 'iShares 0-3 Month Treasury Bond ETF', asset_type: 'etf', rwa_rank: 7773, has_tokens: true, provider_capability: 'rwaInfo', captured_at: '2026-09-30T03:29:00.000Z', provider_fetched_at: '2026-09-30T03:28:00.000Z' },
      { rwa_id: 900, slug: 'nvda-lookalike', symbol: 'NVDA', name: 'Lookalike', asset_type: 'stock', rwa_rank: 5000, has_tokens: false, provider_capability: 'rwaInfo', captured_at: '2026-09-30T03:29:00.000Z', provider_fetched_at: null },
    ],
    intel_rwa_wrapper_assets: [
      { rwa_id: '2', captured_at: '2026-09-30T20:00:00.000Z', fetched_at: '2026-09-30T20:00:05.000Z', anchor_kind: 'wrapper_median', anchor_price: 228.5, wrapper_count: 2, liquid_count: 1, widest_premium_bps: 7.7, widest_discount_bps: -5.7, dispersion_bps: 13.4, weighted_spread_bps: 3.1, average_tokenized_price: 227.9, tokenized_market_cap: 130000000, tokenized_volume_24h: 150000000, source_observed_at: '2026-09-30T19:59:00.000Z' },
    ],
    intel_rwa_wrapper_tokens: [
      { rwa_id: '2', crypto_id: '36992', captured_at: '2026-09-30T20:00:00.000Z', symbol: 'NVDAX', name: 'NVIDIA xStock', issuer_name: 'Backed Assets', price: 228.1, market_cap: 42000000, volume_24h: 38000000, wrapper_state: 'liquid', premium_bps: 7.7 },
    ],
    intel_rwa_coverage_assets: [
      { rwa_id: '242', captured_at: '2026-09-30T19:20:00.000Z', fetched_at: '2026-09-30T19:20:00.000Z', token_count: 3, priced_count: 3, traded_count: 2, coverage_state: 'traded', tokenized_market_cap: 12571809.66, tokenized_volume_24h: 1000, source_observed_at: '2026-09-30T19:00:00.000Z' },
    ],
    provider_call_logs: [
      { provider: 'coinmarketcap', caller: 'intel-capture-rwa-asset-profiles', endpoint: '/v5/real-world-assets/info', cache_status: 'live', status_code: 200, credits_or_cu: 1, ts: '2026-09-30T03:28:00.000Z' },
      { provider: 'coinmarketcap', caller: 'intel-capture-rwa-wrappers', endpoint: '/v5/real-world-assets/quotes/latest', cache_status: 'live', status_code: 200, credits_or_cu: 2, ts: '2026-09-30T20:00:04.000Z' },
      { provider: 'coinmarketcap', caller: 'intel-capture-rwa-coverage', endpoint: '/v5/real-world-assets/quotes/latest', cache_status: 'live', status_code: 200, credits_or_cu: 8, ts: '2026-09-30T19:19:00.000Z' },
    ],
  }
}

const cacheHit = (fetchedAt = '2026-10-05T11:55:00.000Z') => ({
  state: 'cached', reason: null, payload: NVDA_BODY,
  receipt: { origin: 'cache', httpStatus: 200, creditCount: null, fetchedAt, parameters: { rwa_id: '2' } },
  provenance: { fetchedAt },
})
const liveOk = () => ({
  state: 'fresh', reason: null, payload: NVDA_BODY,
  receipt: { origin: 'live', httpStatus: 200, creditCount: 1, fetchedAt: '2026-10-05T12:00:00.000Z', reservation: 'res-1', parameters: { rwa_id: '2' } },
  provenance: { fetchedAt: '2026-10-05T12:00:00.000Z' },
})
// After 30 Sep: the Basic key is refused on the RWA endpoints.
const live402 = () => ({ state: 'unavailable', reason: 'provider_unavailable', payload: null, receipt: { origin: 'live', httpStatus: 402, creditCount: 0 }, provenance: {} })
const cacheMiss = () => ({ state: 'unavailable', reason: 'refresh_required', payload: null, receipt: null, provenance: {} })

function deps(db: ReturnType<typeof fakeDb>, reads: Partial<Record<FreeRwaPlan, () => Row>>, claim = true) {
  const calls: FreeRwaPlan[] = []
  let claims = 0
  const d = {
    db, now: () => NOW,
    readQuote: (_id: string) => async (plan: FreeRwaPlan) => { calls.push(plan); return (reads[plan] ?? cacheMiss)() },
    claim: async () => { claims++; return { allowed: claim, reason: claim ? null : 'free_rwa_budget_exhausted', cap: 200, used: 200 } },
  }
  return { d, calls, claims: () => claims }
}

Deno.test('validation: tickers, names and ids pass; wildcards, filters and junk are refused', () => {
  assertEquals(parseLookupQuery(' nvda '), { kind: 'text', value: 'nvda', text: 'nvda' })
  assertEquals(parseLookupQuery('242').kind, 'rwa_id')
  assertEquals(parseLookupQuery('Berkshire Hathaway Inc. (B)').kind, 'text')
  for (const bad of ['', ' ', '%', 'NV%DA', 'a_b', 'a*b', 'a,b', 'x'.repeat(61), '0', '-NVDA', '<script>', 42, null, {}, ['NVDA']]) {
    assertThrows(() => parseLookupQuery(bad), Error, 'invalid_query', String(bad))
  }
})

Deno.test('cache first: a shared cache hit answers with no claim and no live pass', async () => {
  const db = fakeDb(tables())
  const { d, calls, claims } = deps(db, { 'shared-cache': cacheHit })
  const out = await lookupRwa(d, parseLookupQuery('NVDA'), true)
  assertEquals(calls, ['shared-cache'])
  assertEquals(claims(), 0)
  assertEquals(out.state, 'found')
  assertEquals(out.asset?.rwaId, '2')
  assertEquals(out.alternatives.map((a) => a.rwaId), ['900'])
  const q = out.figures!.quote!
  assertEquals(q.value?.averageTokenizedPrice, 228.42)
  assertEquals(q.receipt.served, 'cache')
  assertEquals(q.receipt.ageSeconds, 300)
  assertEquals(q.receipt.httpStatus, 200)
  assertEquals(q.receipt.creditCount, null)
  assertEquals(q.receipt.curlMeaning, 'same_request')
  assert(q.receipt.curl!.includes('$CMC_API_KEY') && q.receipt.curl!.includes("'rwa_id=2'"))
  // Wrappers come from the quote, the premium from the capture hour, each its own receipt.
  assertEquals(out.figures!.wrappers!.value[0], { cryptoId: '36992', symbol: 'NVDAX', name: 'NVIDIA xStock', issuerName: 'Backed Assets', price: 228.68, marketCap: 42015407.81, volume24h: 38764552.79, premiumBps: 7.7, wrapperState: 'liquid', derivative: false })
  // A reported zero market cap stays zero.
  assertEquals(out.figures!.wrappers!.value[1].marketCap, 0)
  assertEquals(out.figures!.premium!.value.widestPremiumBps, 7.7)
  assertEquals(out.figures!.premium!.receipt.served, 'capture')
  assertEquals(out.figures!.premium!.receipt.creditCount, 2)
  assertEquals(out.figures!.identity.receipt.httpStatus, 200)
  assertEquals(out.attribution, 'Data provided by CoinMarketCap.com')
  // The good answer is remembered for a later failed miss.
  assertEquals(db.rpcLog.filter((r) => r.name === 'intel_rwa_lookup_remember').length, 1)
})

Deno.test('a miss claims the daily budget once, then reads live; the curl is this call', async () => {
  const db = fakeDb(tables())
  const { d, calls, claims } = deps(db, { 'shared-live': liveOk })
  const out = await lookupRwa(d, parseLookupQuery('nvidia'), true)
  assertEquals(calls, ['shared-cache', 'shared-live'])
  assertEquals(claims(), 1)
  const r = out.figures!.quote!.receipt
  assertEquals([r.served, r.httpStatus, r.creditCount, r.ageSeconds, r.curlMeaning], ['live', 200, 1, 0, 'this_call'])
  assertFalse(JSON.stringify(out).includes('res-1'))
})

Deno.test('no live allowance for this IP: no claim and no live pass, still an answer', async () => {
  const db = fakeDb(tables())
  const { d, calls, claims } = deps(db, { 'shared-live': liveOk })
  const out = await lookupRwa(d, parseLookupQuery('NVDA'), false)
  assertEquals(calls, ['shared-cache'])
  assertEquals(claims(), 0)
  // Falls to the wrapper capture, dated and with the lane's reason.
  assertEquals(out.state, 'found')
  assertEquals(out.figures!.quote!.receipt.served, 'capture')
  assertEquals(out.figures!.quote!.value?.averageTokenizedPrice, 227.9)
  assertEquals(out.figures!.quote!.receipt.reason, 'free_rwa_background_read')
})

Deno.test('after 30 Sep: a failed live miss serves the last good copy with its age and the honest reason', async () => {
  const t = tables()
  t.intel_rwa_lookup_last_good = [{ rwa_id: 2, payload: NVDA_BODY, fetched_at: '2026-09-30T23:00:00.000Z', http_status: 200, credit_count: 1, served_as: 'live' }]
  const db = fakeDb(t)
  const { d } = deps(db, { 'shared-live': live402 })
  const out = await lookupRwa(d, parseLookupQuery('NVDA'), true)
  const q = out.figures!.quote!
  assertEquals(out.state, 'found')
  assertEquals(q.receipt.served, 'retained')
  assertEquals(q.receipt.capturedAt, '2026-09-30T23:00:00.000Z')
  assertEquals(q.receipt.ageSeconds, (NOW - Date.parse('2026-09-30T23:00:00.000Z')) / 1000)
  assertEquals(q.receipt.httpStatus, 200)
  assertEquals(q.receipt.reason, 'provider_unavailable')
  assertEquals(q.value?.averageTokenizedPrice, 228.42)
})

Deno.test('no last good copy either: the newest stored capture answers, never an empty "no data"', async () => {
  const db = fakeDb(tables())
  const { d } = deps(db, { 'shared-live': live402 })
  const out = await lookupRwa(d, parseLookupQuery('sgov'), true)
  assertEquals(out.state, 'found')
  const q = out.figures!.quote!
  assertEquals(q.receipt.served, 'capture')
  assertEquals(q.receipt.caller, 'intel-capture-rwa-coverage')
  assertEquals(q.value?.tokenizedMarketCap, 12571809.66)
  assertEquals(q.receipt.reason, 'provider_unavailable')
  assertEquals(q.receipt.creditCount, 8)
})

Deno.test('a spent daily budget is a reason, not an error', async () => {
  const db = fakeDb(tables())
  const { d, calls } = deps(db, {}, false)
  const out = await lookupRwa(d, parseLookupQuery('NVDA'), true)
  assertEquals(calls, ['shared-cache'])
  assertEquals(out.figures!.quote!.receipt.reason, 'free_rwa_budget_exhausted')
})

Deno.test('an unknown ticker is not_found against a named catalogue, and a dead catalogue says so', async () => {
  const db = fakeDb(tables())
  const { d, calls } = deps(db, {})
  const out = await lookupRwa(d, parseLookupQuery('ZZZZQ'), true)
  assertEquals(out.state, 'not_found')
  assertEquals(out.reason, 'no_rwa_match')
  assertEquals(out.catalogue?.count, 3)
  assertEquals(calls, [])
  const dead = await lookupRwa(deps(fakeDb(tables(), { failTables: ['intel_rwa_asset_profiles'] }), {}).d, parseLookupQuery('NVDA'), true)
  assertEquals(dead.state, 'unavailable')
  assertEquals(dead.reason, 'catalogue_unavailable')
})

Deno.test('raw excerpts are trimmed: no prose, short arrays, short strings', () => {
  const t = trimRaw({ description: 'x'.repeat(5000), list: Array.from({ length: 9 }, (_, i) => i), s: 'y'.repeat(400) }) as Row
  assertEquals(t.description, '[omitted]')
  assertEquals(t.list.length, 6)
  assert(t.s.length <= 161)
  assertEquals(reproduceLine('nope', {}), null)
})

function handlerDeps(db: ReturnType<typeof fakeDb>, reads: Partial<Record<FreeRwaPlan, () => Row>>, limiter?: HandlerDeps['limit'], research: Partial<Record<FreeRwaPlan, () => Row>> = {}) {
  const counts = new Map<string, number>()
  const base = deps(db, reads).d
  const h: HandlerDeps = {
    ...base,
    readResearch: () => async (plan) => (research[plan] ?? cacheMiss)(),
    claimResearch: async () => ({ allowed: true, reason: null, cap: 200, used: 1 }),
    researchParams,
    ipKey: async (req, bucket) => `ip:${req.headers.get('x-forwarded-for') || 'unknown'}:${bucket}`,
    limit: limiter ?? (async (key, limit) => { const n = (counts.get(key) || 0) + 1; counts.set(key, n); return { ok: n <= limit, retryAfter: 60 } }),
    secrets: () => [KEY],
  }
  return h
}
const post = (body: unknown, ip = '1.1.1.1', headers: Record<string, string> = {}) => new Request('https://x/functions/v1/intel-rwa-lookup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })

Deno.test('handler: validation codes, one field only, GET works, OPTIONS answers CORS', async () => {
  const h = handlerDeps(fakeDb(tables()), { 'shared-cache': cacheHit })
  assertEquals((await handleLookup(post({ q: 'NV%' }), h)).status, 400)
  assertEquals((await handleLookup(post({ q: 'NVDA', orgId: 'x' }), h)).status, 400)
  assertEquals((await handleLookup(post('not json'), h)).status, 400)
  assertEquals((await handleLookup(post({ q: 'x'.repeat(5000) }), h)).status, 413)
  assertEquals((await handleLookup(new Request('https://x/f?q=NVDA', { method: 'DELETE' }), h)).status, 405)
  const get = await handleLookup(new Request('https://x/f?q=NVDA', { headers: { 'x-forwarded-for': '2.2.2.2' } }), h)
  assertEquals(get.status, 200)
  assertEquals(get.headers.get('access-control-allow-origin'), '*')
  assertEquals((await get.json()).asset.symbol, 'NVDA')
  const pre = await handleLookup(new Request('https://x/f', { method: 'OPTIONS' }), h)
  assertEquals(pre.status, 200)
})

Deno.test('handler: the per-IP limit answers 429 with Retry-After, other IPs unaffected', async () => {
  const h = handlerDeps(fakeDb(tables()), { 'shared-cache': cacheHit })
  const statuses: number[] = []
  for (let i = 0; i < LOOKUP_RATE.limit + 3; i++) statuses.push((await handleLookup(post({ q: 'NVDA' }, '9.9.9.9'), h)).status)
  assertEquals(statuses.filter((s) => s === 200).length, LOOKUP_RATE.limit)
  assertEquals(statuses.slice(-3), [429, 429, 429])
  const refused = await handleLookup(post({ q: 'NVDA' }, '9.9.9.9'), h)
  assertEquals(refused.headers.get('retry-after'), '60')
  assertEquals((await handleLookup(post({ q: 'NVDA' }, '8.8.8.8'), h)).status, 200)
})

Deno.test('handler: the live allowance is per IP and fails closed', async () => {
  let live = 0
  const db = fakeDb(tables())
  const h = handlerDeps(db, { 'shared-live': () => { live++; return liveOk() } })
  for (let i = 0; i < LOOKUP_LIVE_RATE.limit + 2; i++) await handleLookup(post({ q: 'NVDA' }, '7.7.7.7'), h)
  assertEquals(live, LOOKUP_LIVE_RATE.limit)
  // A limiter that errors on the live bucket: no live pass, answer still served.
  live = 0
  const broken = handlerDeps(fakeDb(tables()), { 'shared-live': () => { live++; return liveOk() } },
    async (key, _l, _w, opts) => opts?.failClosed ? { ok: false, retryAfter: 30 } : { ok: true, retryAfter: 0 })
  const res = await handleLookup(post({ q: 'NVDA' }, '6.6.6.6'), broken)
  assertEquals(res.status, 200)
  assertEquals(live, 0)
  // No salt (ipKey throws): nothing reaches the provider.
  const noSalt: HandlerDeps = { ...handlerDeps(fakeDb(tables()), { 'shared-live': () => { live++; return liveOk() } }), ipKey: () => Promise.reject(new Error('salt')) }
  assertEquals((await handleLookup(post({ q: 'NVDA' }), noSalt)).status, 200)
  assertEquals(live, 0)
})

Deno.test('handler: the key never leaves in any body, even if a row carried it', async () => {
  const t = tables()
  t.intel_rwa_asset_profiles[0].website = `https://example.com/?k=${KEY}`
  const h = handlerDeps(fakeDb(t), { 'shared-cache': cacheHit })
  for (const req of [post({ q: 'NVDA' }), post({ q: 'SGOV' }), post({ q: 'ZZZZQ' }), post({ q: '%' })]) {
    const text = await (await handleLookup(req, h)).text()
    assertFalse(text.includes(KEY))
    assertFalse(/X-CMC_PRO_API_KEY: [^$]/.test(text))
  }
  assertEquals(scrubSecrets(`a${KEY}b`, [KEY, null, 'short']), 'a[redacted]b')
})

// ─── Research mode: the /intel/rwa reads, as a free member gets them ─────────

const LIST_BODY = (fetchedAt: string, origin = 'cache') => ({
  version: 1, capability: 'rwaList', state: origin === 'live' ? 'fresh' : 'cached', reason: null,
  data: { rows: [{ rwa_id: 6, name: 'Asset six' }], total: 791, hasMore: true },
  provenance: { provider: 'coinmarketcap', fetchedAt },
  receipt: { capability: 'rwaList', origin, httpStatus: 200, creditCount: origin === 'live' ? 1 : null, fetchedAt, reservation: origin === 'live' ? 'res-9' : null, cacheAgeSeconds: 0 },
})

function researchDeps(db: ReturnType<typeof fakeDb>, reads: Partial<Record<FreeRwaPlan, () => Row>>, claim = true) {
  const calls: { plan: FreeRwaPlan; capability: string; params: Record<string, string> }[] = []
  let claims = 0
  return {
    calls, claims: () => claims,
    d: {
      db, now: () => NOW, researchParams,
      readResearch: (capability: string, params: Record<string, string>) => async (plan: FreeRwaPlan) => { calls.push({ plan, capability, params }); return (reads[plan] ?? cacheMiss)() },
      claimResearch: async () => { claims++; return { allowed: claim, reason: claim ? null : 'free_rwa_budget_exhausted', cap: 200, used: 200 } },
    },
  }
}

Deno.test('research: only the six RWA capabilities, only capability/params/readMode, the same param validation', () => {
  const ok = parseResearchRequest({ capability: 'rwaList', params: { start: 26, limit: 25 } }, researchParams)
  assertEquals(ok.params, { limit: '25', start: '26' })
  assertEquals(ok.cacheOnly, false)
  for (const [body, code] of [
    [{ capability: 'quotes', params: { id: 1 } }, 'unsupported_capability'],
    [{ capability: 'dexCohort' }, 'unsupported_capability'],
    [{ capability: 'rwaList', orgId: 'x' }, 'invalid_request'],
    [{ capability: 'rwaList', readMode: 'live' }, 'invalid_read_mode'],
    [{ capability: 'rwaList', params: { limit: 500 } }, 'invalid_parameter'],
    [{ capability: 'rwaInfo', params: { symbol: 'NVDA' } }, 'stable_identifier_required'],
  ] as [Row, string][]) assertThrows(() => parseResearchRequest(body, researchParams), Error, code)
})

Deno.test('research: a cache hit is the free member body, unchanged, and is kept', async () => {
  const db = fakeDb(tables())
  const r = researchDeps(db, { 'shared-cache': () => LIST_BODY('2026-10-05T11:30:00.000Z') })
  const req = parseResearchRequest({ capability: 'rwaList', params: { start: 26, limit: 25 } }, researchParams)
  const out = await researchRwa(r.d, req, true) as Row
  assertEquals(r.claims(), 0)
  assertEquals(out.data.total, 791)
  assertEquals(out.freeShared, { lane: 'rwa_research', served: 'shared-cache' })
  assertEquals(out.refreshPolicy.enabled, false)
  assertEquals(db.rpcLog.filter((c) => c.name === 'intel_rwa_lookup_research_remember').length, 1)
})

Deno.test('research: after 30 Sep a failed live miss serves the kept copy, dated, with the reason', async () => {
  const t = tables()
  t.intel_rwa_lookup_research_last_good = [{ capability: 'rwaList', params_key: JSON.stringify({ limit: '25', start: '26' }), body: LIST_BODY('2026-09-30T22:00:00.000Z', 'live'), fetched_at: '2026-09-30T22:00:00.000Z' }]
  const r = researchDeps(fakeDb(t), { 'shared-live': live402 })
  const out = await researchRwa(r.d, parseResearchRequest({ capability: 'rwaList', params: { start: 26, limit: 25 } }, researchParams), true) as Row
  assertEquals(r.claims(), 1)
  assertEquals(out.state, 'stale')
  assertEquals(out.data.rows[0].rwa_id, 6)
  assertEquals(out.freeShared.served, 'retained')
  assertEquals(out.freeShared.reason, 'provider_unavailable')
  assertEquals(out.freeShared.ageSeconds, (NOW - Date.parse('2026-09-30T22:00:00.000Z')) / 1000)
  assertEquals([out.receipt.origin, out.receipt.creditCount, out.receipt.reservation, out.receipt.httpStatus], ['cache', null, null, 200])
  assertEquals(out.receipt.cacheAgeSeconds, out.freeShared.ageSeconds)
})

Deno.test('research: nothing kept either is the lane body with its honest reason, not an empty success', async () => {
  const r = researchDeps(fakeDb(tables()), { 'shared-live': live402 })
  const out = await researchRwa(r.d, parseResearchRequest({ capability: 'rwaInfo', params: { rwa_id: 6 } }, researchParams), true) as Row
  assertEquals(out.state, 'unavailable')
  assertEquals(out.freeShared.served, 'retained')
  assertEquals(out.freeShared.reason, 'provider_unavailable')
})

Deno.test('research: a background (retained) read and a closed IP gate never claim the budget', async () => {
  const r = researchDeps(fakeDb(tables()), { 'shared-live': () => LIST_BODY('2026-10-05T12:00:00.000Z', 'live') })
  await researchRwa(r.d, parseResearchRequest({ capability: 'rwaList', params: { start: 1, limit: 25 }, readMode: 'retained' }, researchParams), true)
  assertEquals(r.claims(), 0)
  const gated = await researchRwa(r.d, parseResearchRequest({ capability: 'rwaList', params: { start: 1, limit: 25 } }, researchParams), async () => false) as Row
  assertEquals(r.claims(), 0)
  assertEquals(gated.freeShared.reason, IP_LIVE_LIMIT_REASON)
  assertEquals(r.calls.map((c) => c.plan), ['shared-cache', 'shared-cache'])
})

Deno.test('handler: research bodies route to the free lane; orgId is refused; no key in the body', async () => {
  const h = handlerDeps(fakeDb(tables()), {}, undefined, { 'shared-cache': () => LIST_BODY('2026-10-05T11:30:00.000Z') })
  const ok = await handleLookup(post({ capability: 'rwaList', params: { start: 26, limit: 25 } }), h)
  assertEquals(ok.status, 200)
  const text = await ok.text()
  assertFalse(text.includes(KEY))
  assertEquals(JSON.parse(text).capability, 'rwaList')
  assertEquals((await handleLookup(post({ capability: 'rwaList', orgId: 'org', params: {} }), h)).status, 400)
  assertEquals((await handleLookup(post({ capability: 'quotes', params: { id: 1 } }), h)).status, 400)
  assertEquals((await handleLookup(post({ capability: 'rwaList', q: 'NVDA' }), h)).status, 400)
})
