// Keyless demo mode. CoinMarketCap publishes a curated subset of its API with
// no key, no signup and no headers; this module is the only place in the
// extraction that speaks to it, and it exists so a judge can replay the three
// demonstrations with real data on their own machine.
//
// Caveat, verbatim from the utilization audit:
//   "keyless commercial terms are unstated; keep it to the demo until reviewed"
//
// Rules this module enforces, not merely documents:
//  * No key is ever read or sent. The request carries exactly one header.
//  * Every answer is labelled `source:'coinmarketcap_keyless'` with the time the
//    answer was produced, and a successful one also carries the provider's own
//    observation clock.
//  * A 30-second in-memory cache per route. Nothing keyless is written to disk.
//  * 60 keyless requests a minute and 600 per process run, after which the route
//    answers `keyless_budget_exhausted`. It never silently falls back to the
//    fixture: a mode that quietly invents data is worse than one that stops.
//
// Endpoint list read from
// https://pro.coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api.md
// on 2026-09-15. See docs/investor-intel/keyless-demo-mode.md for the probe log.
import { CMC_CAPABILITIES, cmcParams, cmcRows, cmcObservedAt } from './cmc-capabilities.ts'
import { cmcDexNetwork, cmcDexAddress } from './cmc-dex.ts'

export const KEYLESS_BASE = 'https://pro-api.coinmarketcap.com/public-api'
export const KEYLESS_SOURCE = 'coinmarketcap_keyless'
export const KEYLESS_DOC = 'https://pro.coinmarketcap.com/api/documentation/pro-api-reference/keyless-public-api.md'
export const KEYLESS_CAVEAT = 'keyless commercial terms are unstated; keep it to the demo until reviewed'
export const KEYLESS_CACHE_MS = 30000
export const KEYLESS_MINUTE_CEILING = 60
export const KEYLESS_RUN_CEILING = 600
export const KEYLESS_MAX_ROWS = 100

// Documented keyless routes this demo maps. Every path but `dexCandles` is the
// keyed path with the `/public-api` prefix, which `keyless.test.mjs` asserts
// against the shared capability catalog so the two can never drift apart.
export const KEYLESS_ENDPOINTS = {
  quotes: { path: '/v3/cryptocurrency/quotes/latest', convert: true, journey: 'personal' },
  metadata: { path: '/v2/cryptocurrency/info', journey: 'personal' },
  dexCandles: { path: '/v1/k-line/candles', journey: 'personal' },
  listings: { path: '/v3/cryptocurrency/listings/latest', convert: true, journey: 'structure' },
  categories: { path: '/v1/cryptocurrency/categories', journey: 'structure' },
  global: { path: '/v1/global-metrics/quotes/latest', convert: true, journey: 'structure' },
  fearGreed: { path: '/v3/fear-and-greed/latest', journey: 'structure' },
  altcoinSeason: { path: '/v1/altcoin-season-index/latest', journey: 'structure' },
  cmc100: { path: '/v3/index/cmc100-latest', journey: 'structure' },
  cmc20: { path: '/v3/index/cmc20-latest', journey: 'structure' },
  dexToken: { path: '/v1/dex/token', journey: 'structure' },
  dexSecurity: { path: '/v1/dex/security/detail', journey: 'structure' },
  dexHolderCount: { path: '/v1/dex/holders/count', journey: 'structure' },
}

// Demo routes the keyless subset does not publish. They answer honestly rather
// than quietly borrowing the fixture; the reason names the key that would be
// required and the journey keeps its fixture-mode demonstration.
export const KEYLESS_NO_EQUIVALENT = {
  ohlcv: 'The keyless subset publishes no /v2/cryptocurrency/ohlcv/historical. The keyless chart uses k-line candles for a contract instead; keyed OHLCV needs a Startup key.',
  history: 'The keyless subset publishes no /v3/cryptocurrency/quotes/historical. A quote line series needs a key.',
  rwaList: 'The keyless subset publishes no real-world-asset endpoints. Run CMC_MODE=fixture for the RWA demonstration, or supply a key.',
  rwaInfo: 'The keyless subset publishes no real-world-asset endpoints. Run CMC_MODE=fixture for the RWA demonstration, or supply a key.',
  rwaQuotes: 'The keyless subset publishes no real-world-asset endpoints. Run CMC_MODE=fixture for the RWA demonstration, or supply a key.',
  issuers: 'The keyless subset publishes no real-world-asset issuer endpoints. Run CMC_MODE=fixture for the RWA demonstration, or supply a key.',
  issuer: 'The keyless subset publishes no real-world-asset issuer endpoints. Run CMC_MODE=fixture for the RWA demonstration, or supply a key.',
  derivativeExchanges: 'The keyless subset publishes no derivatives endpoints. The keyless market-structure journey uses global metrics, listings, categories, sentiment, indices and DEX contract evidence instead.',
  derivativePairs: 'The keyless subset publishes no derivatives endpoints. The keyless market-structure journey uses global metrics, listings, categories, sentiment, indices and DEX contract evidence instead.',
  liquidations: 'The keyless subset publishes no derivatives endpoints. The keyless market-structure journey uses global metrics, listings, categories, sentiment, indices and DEX contract evidence instead.',
}

// k-line takes a named candle width, never an arbitrary sampling period.
export const KLINE_INTERVALS = { '1min': 60000, '5min': 300000, '15min': 900000, '30min': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000, '1w': 604800000 }

/** k-line is not in the shared capability catalog, so it is validated here with
 * the same refusals: verified platform aliases only, a real contract address,
 * one named candle width, a USD unit and a bounded row count. */
function klineParams(input = {}) {
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === '') continue
    if (!['platform', 'address', 'interval', 'unit', 'limit'].includes(key)) throw new Error(`invalid_parameter:${key}`)
    out[key] = String(value)
  }
  if (!cmcDexNetwork(out.platform)) throw new Error('unverified_dex_platform')
  if (!cmcDexAddress(out.address, out.platform)) throw new Error('invalid_contract_address')
  out.address = /^0x/i.test(out.address) ? out.address.toLowerCase() : out.address
  out.interval ||= '1d'
  if (!Object.hasOwn(KLINE_INTERVALS, out.interval)) throw new Error('invalid_candle_interval')
  out.unit ||= 'usd'
  if (out.unit !== 'usd') throw new Error('invalid_candle_unit')
  out.limit ||= '90'
  if (!/^[1-9][0-9]*$/.test(out.limit)) throw new Error('invalid_parameter:limit')
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

/** Canonical, bounded parameters for one keyless route. */
export function keylessParams(capability, input = {}) {
  const params = capability === 'dexCandles' ? klineParams(input) : cmcParams(capability, input)
  if (Number(params.limit || params.count || 0) > KEYLESS_MAX_ROWS) throw new Error('maximum_rows_100')
  for (const id of ['id', 'crypto_id', 'slug']) if ((params[id]?.split(',').length || 0) > 20) throw new Error('maximum_identifiers_20')
  return params
}

/** k-line answers a bare array of positional rows
 * `[open,high,low,close,volume,timestampSeconds,traders]`. The timestamp is the
 * period OPEN in seconds; no close time is published, so none is invented here.
 * Everything else shares the catalog's normalization. */
export function keylessRows(capability, body, params = {}) {
  if (capability !== 'dexCandles') return cmcRows(capability, body)
  const data = body?.data
  const raw = Array.isArray(data) ? data : Array.isArray(data?.candles) ? data.candles : []
  const number = (value) => { const n = Number(value); return Number.isFinite(n) ? n : null }
  const rows = raw.slice(0, 1000).map((row) => {
    if (!Array.isArray(row) || row.length < 6) return null
    const [o, h, l, c, v, seconds] = row.slice(0, 6).map(number)
    if ([o, h, l, c].some((n) => n == null || !(n > 0)) || h < Math.max(o, c) || l > Math.min(o, c) || seconds == null || seconds <= 0) return null
    return { o, h, l, c, v: v != null && v >= 0 ? v : null, t: seconds < 1e12 ? seconds * 1000 : seconds, traders: number(row[6]) }
  }).filter(Boolean).sort((a, b) => a.t - b.t)
  // The candle width the REQUEST pinned, so a reader can derive a close time and
  // know it was derived. The provider publishes no close time.
  return { rows, total: rows.length, hasMore: false, barIntervalMs: KLINE_INTERVALS[params.interval] ?? null, interval: params.interval ?? null }
}

/** The provider's own clock for this answer, never the local retrieval time. */
function keylessObservedAt(capability, body, rows) {
  if (capability !== 'dexCandles') return cmcObservedAt(body, capability)
  const newest = rows.rows.at(-1)?.t
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null
}

const message = (body) => {
  const text = body?.status?.error_message
  return typeof text === 'string' && text.trim() ? text.trim().replace(/\s+/g, ' ').slice(0, 300) : null
}
const errored = (body) => {
  const code = body?.status?.error_code
  return code != null && code !== '' && Number(code) !== 0
}

/** One keyless client per server process. Cache and ceilings are in memory: a
 * restart forgets the cache and resets the run ceiling, which is deliberate for
 * a demonstration and is stated in the README. */
export function createKeylessClient({ fetcher = fetch, now = () => Date.now(), cacheMs = KEYLESS_CACHE_MS, minuteCeiling = KEYLESS_MINUTE_CEILING, runCeiling = KEYLESS_RUN_CEILING, timeoutMs = 8000 } = {}) {
  const cache = new Map()
  const minute = []
  let used = 0, hits = 0

  const envelope = (capability, patch) => ({
    version: 1, capability, mode: 'keyless', source: KEYLESS_SOURCE, fixture: false,
    state: 'unavailable', code: null, retrievedAt: new Date(now()).toISOString(),
    data: { rows: [], total: null, hasMore: false }, reason: null,
    provenance: { provider: KEYLESS_SOURCE, observedAt: null, fetchedAt: null, expiresAt: null, sourceUrl: KEYLESS_DOC },
    ...patch,
  })
  const fail = (capability, code, reason) => envelope(capability, { code, reason })

  function budget(capability) {
    const cutoff = now() - 60000
    while (minute.length && minute[0] <= cutoff) minute.shift()
    if (minute.length >= minuteCeiling) return fail(capability, 'keyless_budget_exhausted', `The keyless ceiling of ${minuteCeiling} requests a minute is reached. No fixture is substituted; retry shortly.`)
    if (used >= runCeiling) return fail(capability, 'keyless_budget_exhausted', `The keyless ceiling of ${runCeiling} requests for this server run is reached. No fixture is substituted; restart the server to reset it.`)
    return null
  }

  async function read(capability, input = {}) {
    const absent = KEYLESS_NO_EQUIVALENT[capability]
    if (absent) return fail(capability, 'keyless_unavailable', absent)
    const spec = KEYLESS_ENDPOINTS[capability]
    if (!spec) throw new Error('unsupported_capability')
    const params = keylessParams(capability, input)

    const cacheKey = `${capability}|${JSON.stringify(params)}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expires > now()) { hits++; return cached.payload }
    if (cached) cache.delete(cacheKey)

    const exhausted = budget(capability)
    if (exhausted) return exhausted
    minute.push(now())
    used++

    const url = new URL(KEYLESS_BASE + spec.path)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    if (spec.convert) url.searchParams.set('convert', 'USD')
    // A keyless request that ever left this host or prefix would not be keyless.
    if (!url.href.startsWith(`${KEYLESS_BASE}/`)) throw new Error('keyless_host_violation')

    let response, body
    try {
      // Exactly one header. No key is read from the environment or sent, and no
      // credential of any kind belongs on this request.
      response = await fetcher(url.href, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
      const raw = await response.text()
      if (raw.length > 2000000) return fail(capability, 'keyless_provider_unavailable', 'The keyless response exceeds the local size bound.')
      body = JSON.parse(raw)
    } catch (error) {
      return fail(capability, 'keyless_provider_unavailable', `The keyless endpoint could not be read (${String(error?.message || error).slice(0, 120)}).`)
    }
    if (response.status === 429) return fail(capability, 'keyless_rate_limited', `The shared keyless IP pool refused this request. ${message(body) || 'The provider returned 429 Too Many Requests.'}`)
    if (!response.ok || errored(body)) return fail(capability, 'keyless_provider_unavailable', `The keyless endpoint answered ${response.status}. ${message(body) || 'No provider message was returned.'}`)
    if (body?.data == null) return fail(capability, 'keyless_provider_unavailable', 'The keyless response carried no data.')

    const rows = keylessRows(capability, body, params)
    const retrievedAt = new Date(now()).toISOString()
    const payload = envelope(capability, {
      state: 'fresh', retrievedAt, data: rows,
      provenance: { provider: KEYLESS_SOURCE, observedAt: keylessObservedAt(capability, body, rows), fetchedAt: retrievedAt, expiresAt: new Date(now() + cacheMs).toISOString(), sourceUrl: KEYLESS_DOC },
    })
    cache.set(cacheKey, { payload, expires: now() + cacheMs })
    return payload
  }

  const stats = () => {
    const cutoff = now() - 60000
    while (minute.length && minute[0] <= cutoff) minute.shift()
    return { base: KEYLESS_BASE, source: KEYLESS_SOURCE, caveat: KEYLESS_CAVEAT, cacheSeconds: cacheMs / 1000, minuteCeiling, runCeiling, usedThisRun: used, remainingThisRun: Math.max(0, runCeiling - used), requestsInLastMinute: minute.length, cacheHits: hits, routes: Object.keys(KEYLESS_ENDPOINTS), unavailableRoutes: Object.keys(KEYLESS_NO_EQUIVALENT) }
  }
  return { read, stats }
}

/** Every keyless path but k-line must stay identical to the keyed catalog path.
 * Exported so the test asserts it instead of a reader trusting a comment. */
export const keylessPathDrift = () => Object.entries(KEYLESS_ENDPOINTS)
  .filter(([name]) => CMC_CAPABILITIES[name])
  .filter(([name, spec]) => CMC_CAPABILITIES[name].path !== spec.path)
  .map(([name]) => name)
