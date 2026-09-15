import test from 'node:test'
import assert from 'node:assert/strict'
import { createResearchService } from '../server/governance.mjs'
import { createKeylessClient, keylessRows, keylessPathDrift, KEYLESS_BASE, KEYLESS_ENDPOINTS, KEYLESS_NO_EQUIVALENT, KEYLESS_CAVEAT } from '../server/keyless.mjs'
import { klineBars } from '../src/chart-data.mjs'

const quoteBody = () => Response.json({ data: [{ id: 1027, name: 'Ethereum', symbol: 'ETH', quote: [{ id: 2781, price: 100, last_updated: '2026-09-15T04:00:00.000Z' }] }], status: { error_code: 0 } })
// The exact body the shared keyless pool returned to this network on 2026-09-15.
const anonymousLimit = () => Response.json({ status: { error_code: '1022', error_message: "You've reached the limit for anonymous access. Sign in to activate a free API plan or upgrade for higher limits.", credit_count: 0, timestamp: '2026-09-15T04:32:54.635Z' } }, { status: 429 })
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
const CANDLE = [3100, 3150, 3080, 3120, 12500, 1757894400, 42]
function client(handler, options = {}) {
  const calls = []
  const fetcher = async (url, init) => { calls.push({ url, init }); return handler(url, calls.length) }
  return { calls, keyless: createKeylessClient({ fetcher, ...options }) }
}

test('a keyless answer is labelled, attributed to the documented route and carries no credential', async () => {
  const { calls, keyless } = client(() => quoteBody())
  const result = await keyless.read('quotes', { id: 1027 })
  assert.equal(result.state, 'fresh')
  assert.equal(result.source, 'coinmarketcap_keyless')
  assert.equal(result.mode, 'keyless')
  assert.equal(result.fixture, false)
  assert.equal(result.code, null)
  assert.ok(Number.isFinite(Date.parse(result.retrievedAt)))
  assert.equal(result.provenance.provider, 'coinmarketcap_keyless')
  assert.equal(result.provenance.fetchedAt, result.retrievedAt)
  assert.equal(result.provenance.observedAt, '2026-09-15T04:00:00.000Z')
  assert.equal(result.data.rows[0].quote.price, 100)
  const url = new URL(calls[0].url)
  assert.equal(url.origin + url.pathname, `${KEYLESS_BASE}/v3/cryptocurrency/quotes/latest`)
  assert.equal(url.searchParams.get('id'), '1027')
  assert.equal(url.searchParams.get('convert'), 'USD')
  // Exactly one header, and nothing anywhere in the request resembles a key.
  assert.deepEqual(Object.keys(calls[0].init.headers), ['Accept'])
  assert.ok(!/CMC_PRO_API_KEY|apikey|api_key|authorization/i.test(JSON.stringify(calls[0])))
})

test('every keyless route is a documented public-api path and does not drift from the keyed catalog', () => {
  assert.deepEqual(keylessPathDrift(), [])
  for (const [name, spec] of Object.entries(KEYLESS_ENDPOINTS)) {
    assert.ok(spec.path.startsWith('/v'), name)
    assert.ok(new URL(KEYLESS_BASE + spec.path).pathname.startsWith('/public-api/'), name)
  }
  assert.equal(KEYLESS_CAVEAT, 'keyless commercial terms are unstated; keep it to the demo until reviewed')
})

test('a route the keyless subset does not publish is unavailable, never a fixture', async () => {
  const { calls, keyless } = client(() => { throw Error('Unexpected network') })
  for (const capability of Object.keys(KEYLESS_NO_EQUIVALENT)) {
    const result = await keyless.read(capability, {})
    assert.equal(result.state, 'unavailable', capability)
    assert.equal(result.code, 'keyless_unavailable', capability)
    assert.equal(result.fixture, false, capability)
    assert.deepEqual(result.data.rows, [], capability)
    assert.match(result.reason, /keyless subset publishes no/, capability)
    assert.equal(result.source, 'coinmarketcap_keyless', capability)
  }
  assert.ok(Object.keys(KEYLESS_NO_EQUIVALENT).includes('rwaList'))
  assert.equal(calls.length, 0)
  await assert.rejects(() => keyless.read('newListings', {}), /unsupported_capability/)
})

test('keyless mode is opt-in, discards a configured key and answers the whole demo surface honestly', async () => {
  let calls = 0
  const fetcher = async () => { calls++; throw Error('Unexpected network') }
  const fixture = createResearchService({ fetcher })
  const keyless = createResearchService({ mode: 'keyless', key: 'synthetic-secret', fetcher })
  try {
    assert.equal(fixture.state().mode, 'fixture')
    assert.equal((await fixture.read('quotes', { id: 1027 })).fixture, true)
    const state = keyless.state()
    assert.equal(state.mode, 'keyless')
    assert.equal(state.keyConfigured, false)
    assert.equal(state.keyless.caveat, KEYLESS_CAVEAT)
    assert.equal(state.keyless.minuteCeiling, 60)
    assert.equal(state.keyless.runCeiling, 600)
    const rwa = await keyless.read('rwaList', { limit: 10 })
    assert.equal(rwa.code, 'keyless_unavailable')
    assert.equal(rwa.fixture, false)
    assert.equal(calls, 0)
  } finally { fixture.close(); keyless.close() }
})

test('k-line positional rows become bars whose derived close never draws an open period', async () => {
  const now = 1757980800000 // 2026-09-16T00:00:00Z
  const { keyless } = client(() => Response.json({ data: [CANDLE, [3120, 3200, 3110, 3180, 9000, 1757980800, 7]], status: { error_code: 0 } }), { now: () => now })
  const result = await keyless.read('dexCandles', { platform: 'ethereum', address: WETH, interval: '1d', limit: 90 })
  assert.equal(result.data.barIntervalMs, 86400000)
  assert.equal(result.data.rows.length, 2)
  assert.deepEqual(result.data.rows[0], { o: 3100, h: 3150, l: 3080, c: 3120, v: 12500, t: 1757894400000, traders: 42 })
  assert.equal(result.provenance.observedAt, new Date(1757980800000).toISOString())
  const bars = klineBars(result, now)
  // The 15th closed; the 16th is still open at `now` and is dropped, not drawn.
  assert.equal(bars.length, 1)
  assert.equal(bars[0].t, 1757894400000)
  assert.equal(bars[0].closedAt, 1757894400000 + 86400000 - 1)
  assert.equal(bars[0].volumeUnit, 'USD')
  // Rows that are not a complete, coherent candle are dropped rather than repaired.
  const broken = keylessRows('dexCandles', { data: [[0, 1, 1, 1, 1, 10], [3100, 3000, 3080, 3120, 1, 20], ['x', 1, 1, 1, 1, 30], [3100, 3150, 3080, 3120, -1, 0]] }, { interval: '1h' })
  assert.deepEqual(broken.rows, [])
  assert.equal(broken.barIntervalMs, 3600000)
  assert.deepEqual(klineBars({ data: { rows: [{ o: 1, h: 1, l: 1, c: 1, t: 1 }] } }), [])
})

test('k-line requests refuse an unverified platform, a symbol, a wrong width and an unbounded page', async () => {
  const { calls, keyless } = client(() => { throw Error('Unexpected network') })
  const valid = { platform: 'ethereum', address: WETH, interval: '1d', limit: 90 }
  for (const [input, pattern] of [
    [{ ...valid, platform: 'polygon' }, /unverified_dex_platform/],
    [{ ...valid, address: 'WETH' }, /invalid_contract_address/],
    [{ ...valid, interval: '4d' }, /invalid_candle_interval/],
    [{ ...valid, unit: 'eth' }, /invalid_candle_unit/],
    [{ ...valid, limit: 5000 }, /maximum_rows_100/],
    [{ ...valid, from: 1 }, /invalid_parameter:from/],
  ]) await assert.rejects(() => keyless.read('dexCandles', input), pattern)
  assert.equal(calls.length, 0)
})

test('each route caches for thirty seconds and refetches once the cache expires', async () => {
  let clock = 1757894400000
  const { calls, keyless } = client(() => quoteBody(), { now: () => clock })
  const first = await keyless.read('quotes', { id: 1027 })
  clock += 29000
  assert.deepEqual(await keyless.read('quotes', { id: 1027 }), first)
  assert.equal(calls.length, 1)
  // A different route, and the same route with different parameters, are separate.
  await keyless.read('quotes', { id: 1 })
  await keyless.read('global', {})
  assert.equal(calls.length, 3)
  clock += 2000
  const refetched = await keyless.read('quotes', { id: 1027 })
  assert.equal(calls.length, 4)
  assert.notEqual(refetched.retrievedAt, first.retrievedAt)
  assert.equal(keyless.stats().cacheHits, 1)
})

test('the per-minute ceiling stops keyless traffic and releases after the window rolls', async () => {
  let clock = 1757894400000
  const { calls, keyless } = client(() => quoteBody(), { now: () => clock, cacheMs: 0 })
  for (let i = 0; i < 60; i++) assert.equal((await keyless.read('quotes', { id: 1027 })).state, 'fresh')
  assert.equal(calls.length, 60)
  const blocked = await keyless.read('quotes', { id: 1027 })
  assert.equal(blocked.state, 'unavailable')
  assert.equal(blocked.code, 'keyless_budget_exhausted')
  assert.equal(blocked.fixture, false)
  assert.deepEqual(blocked.data.rows, [])
  assert.match(blocked.reason, /60 requests a minute/)
  assert.equal(calls.length, 60)
  clock += 60001
  assert.equal((await keyless.read('quotes', { id: 1027 })).state, 'fresh')
  assert.equal(calls.length, 61)
})

test('the run ceiling is absolute and is not reset by the passage of time', async () => {
  let clock = 1757894400000
  const { calls, keyless } = client(() => quoteBody(), { now: () => clock, cacheMs: 0, minuteCeiling: 1000, runCeiling: 600 })
  for (let i = 0; i < 600; i++) { clock += 1; await keyless.read('quotes', { id: 1027 }) }
  assert.equal(calls.length, 600)
  clock += 600000
  const blocked = await keyless.read('quotes', { id: 1027 })
  assert.equal(blocked.code, 'keyless_budget_exhausted')
  assert.match(blocked.reason, /600 requests for this server run/)
  assert.equal(calls.length, 600)
  assert.equal(keyless.stats().remainingThisRun, 0)
})

test('a refused, failed or malformed keyless response is reported, never replaced with data', async () => {
  const cases = [
    [anonymousLimit, 'keyless_rate_limited', /limit for anonymous access/],
    [() => Response.json({ status: { error_code: 500, error_message: 'Internal' } }, { status: 500 }), 'keyless_provider_unavailable', /answered 500/],
    [() => Response.json({ data: null, status: { error_code: 1006, error_message: 'Not authorised' } }), 'keyless_provider_unavailable', /Not authorised/],
    [() => Response.json({ status: { error_code: 0 } }), 'keyless_provider_unavailable', /carried no data/],
    [() => new Response('<html>not json</html>', { status: 200 }), 'keyless_provider_unavailable', /could not be read/],
    [() => { throw Error('fetch failed') }, 'keyless_provider_unavailable', /could not be read/],
  ]
  for (const [handler, code, pattern] of cases) {
    const { keyless } = client(handler)
    const result = await keyless.read('quotes', { id: 1027 })
    assert.equal(result.state, 'unavailable', code)
    assert.equal(result.code, code)
    assert.match(result.reason, pattern)
    assert.equal(result.fixture, false)
    assert.deepEqual(result.data.rows, [])
    assert.equal(result.provenance.fetchedAt, null)
    assert.ok(Number.isFinite(Date.parse(result.retrievedAt)))
  }
  // A failure is not cached as if it were an answer.
  const { calls, keyless } = client(anonymousLimit)
  await keyless.read('quotes', { id: 1027 })
  await keyless.read('quotes', { id: 1027 })
  assert.equal(calls.length, 2)
})
