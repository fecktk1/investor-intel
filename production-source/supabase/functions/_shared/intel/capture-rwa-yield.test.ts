import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { captureRwaYield, RWA_YIELD_CAPTURE_OPS, NAV_TABLE, YIELD_TABLE, BENCHMARK_TABLE } from './capture-rwa-yield.ts'
import { RWA_YIELD_FEEDS, RWA_FEED_BY_KEY } from './rwa-yield-register.ts'

const NOW = new Date(Date.UTC(2026, 8, 16, 12, 0, 0))
const HOUR = NOW.toISOString()
const DAY = 86400

const word = (v: bigint | number): string => BigInt(v).toString(16).padStart(64, '0')
function encodeString(value: string): string {
  const bytes = [...value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return '0x' + word(32) + word(value.length) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
}
function encodeRound(roundId: bigint, answer: bigint, updatedAt: number): string {
  return '0x' + word(roundId) + word(answer) + word(0) + word(updatedAt) + word(roundId)
}

const DECIMALS = 8
const LATEST = 1000n
const BASE_AT = Math.floor(NOW.getTime() / 1000) - 3600

/** Per feed: what the chain says its description is, and its NAV series oldest
 * first. Defaults make every registered feed validate with a gentle rise. */
interface FeedFixture { description?: string; navs?: number[] }
const RISING = [1.0, 1.0004, 1.0008, 1.0012, 1.0016, 1.002]
/** The real 2026-09-16 CRDYX shape: multiple consecutive steps down. */
const FALLING = [7.889, 7.889, 7.7693, 7.7609, 7.7609, 7.6763]
const FLAT = [1, 1, 1, 1, 1, 1]

const CURVE_XML = `<feed><entry><content type="application/xml"><m:properties>
  <d:NEW_DATE m:type="Edm.DateTime">2026-09-15T00:00:00</d:NEW_DATE>
  <d:BC_3MONTH m:type="Edm.Double">4.11</d:BC_3MONTH>
</m:properties></content></entry></feed>`
const SOFR_JSON = JSON.stringify({ refRates: [{ effectiveDate: '2026-09-15', type: 'SOFR', percentRate: 3.64 }] })
const ESTR_JSON = JSON.stringify({
  structure: { dimensions: { observation: [{ id: 'TIME_PERIOD', values: [{ id: '2026-09-15' }] }] } },
  dataSets: [{ series: { '0:0:0': { observations: { '0': [2.19] } } } }],
})
const FILING = `<x><seriesId>S000067043</seriesId><nameOfSeries>Franklin OnChain U.S. Government Money Fund</nameOfSeries>
  <reportDate>2026-08-31</reportDate>
  <sevenDayNetYield><sevenDayNetYieldValue>0.0355</sevenDayNetYieldValue><sevenDayNetYieldDate>2026-08-03</sevenDayNetYieldDate></sevenDayNetYield>
  <sevenDayNetYield><sevenDayNetYieldValue>0.0357</sevenDayNetYieldValue><sevenDayNetYieldDate>2026-08-31</sevenDayNetYieldDate></sevenDayNetYield></x>`

/** The mirror, generated from the register so every feed has a row. */
function directory(extra: Record<string, unknown>[] = []) {
  return JSON.stringify([
    ...RWA_YIELD_FEEDS.map((feed) => ({
      name: feed.feedName, proxyAddress: feed.address, decimals: DECIMALS, heartbeat: 97200,
      // Both spellings appear in the real file; using the odd one here keeps the
      // lane honest about matching case-insensitively.
      docs: { productType: feed.key === 'jaaa' ? 'NAVLINK' : 'NAVLink', porAuditor: 'Auditor' },
    })),
    { name: 'ETH / USD', proxyAddress: '0x' + 'b'.repeat(40), decimals: 8, docs: { productType: 'Price' } },
    ...extra,
  ])
}

// deno-lint-ignore no-explicit-any
function fakeRpc(fixtures: Record<string, FeedFixture> = {}, calls?: any[]) {
  return (_url: string, body: unknown, _timeout: number): Promise<unknown> => {
    // deno-lint-ignore no-explicit-any
    const batch = (Array.isArray(body) ? body : [body]) as any[]
    calls?.push(batch)
    return Promise.resolve(batch.map((entry) => {
      const to = String(entry.params?.[0]?.to ?? '').toLowerCase()
      const data = String(entry.params?.[0]?.data ?? '')
      const feed = RWA_YIELD_FEEDS.find((f) => f.address === to)
      if (!feed) return { id: entry.id, error: { message: 'unknown address' } }
      const fixture = fixtures[feed.key] || {}
      const navs = fixture.navs || RISING
      if (data.startsWith('0x7284e416')) return { id: entry.id, result: encodeString(fixture.description ?? feed.feedName) }
      if (data.startsWith('0x313ce567')) return { id: entry.id, result: '0x' + word(DECIMALS) }
      if (data.startsWith('0xfeaf968c')) {
        return { id: entry.id, result: encodeRound(LATEST, BigInt(Math.round(navs[navs.length - 1] * 1e8)), BASE_AT) }
      }
      if (data.startsWith('0x9a6fc8f5')) {
        const asked = BigInt('0x' + data.slice(10))
        const back = Number(LATEST - asked)
        const index = navs.length - 1 - back
        if (index < 0) return { id: entry.id, result: encodeRound(asked, 0n, 0) }
        return { id: entry.id, result: encodeRound(asked, BigInt(Math.round(navs[index] * 1e8)), BASE_AT - back * DAY) }
      }
      return { id: entry.id, error: { message: 'unknown selector' } }
    }))
  }
}

const fakeFetch = (directoryBody: string | null) => (url: string): Promise<string | null> => {
  if (url.includes('reference-data-directory')) return Promise.resolve(directoryBody)
  if (url.includes('home.treasury.gov')) return Promise.resolve(CURVE_XML)
  if (url.includes('fiscaldata')) return Promise.resolve(JSON.stringify({ data: [{ record_date: '2026-08-31', security_desc: 'Treasury Bills', avg_interest_rate_amt: '3.788' }] }))
  if (url.includes('newyorkfed')) return Promise.resolve(SOFR_JSON)
  if (url.includes('ecb.europa.eu')) return Promise.resolve(ESTR_JSON)
  return Promise.resolve(null)
}
const fakeSec = (url: string): Promise<string | null> => Promise.resolve(
  url.includes('efts')
    ? JSON.stringify({ hits: { hits: [{ _id: '0002071691-26-021281:primary_doc.xml', _source: { ciks: ['0001786958'], period_ending: '2026-08-31' } }] } })
    : FILING,
)

/** Minimal PostgREST-shaped fake covering select/eq/order/limit and upsert. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}) {
  return {
    upserts: writes,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, any][] = []
      const run = (max: number | null) => {
        let rows = [...(tables[table] || [])]
        for (const [key, value] of filters) rows = rows.filter((row) => String(row?.[key] ?? '') === String(value ?? ''))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, v]); return q },
        order: () => q,
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => { (writes[table] ||= []).push(...rows); return Promise.resolve({ error: null }) },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'test', caller: name, kind: 'job' as const, maxCalls })
const deps = (over: Record<string, unknown> = {}) => ({
  request: () => Promise.resolve(null), policy: [],
  fetchText: fakeFetch(directory()), fetchWithHeaders: fakeSec, rpcCall: fakeRpc(),
  ...over,
  // deno-lint-ignore no-explicit-any
}) as any

const rowsOf = (writes: Record<string, unknown[]>, table: string) => (writes[table] || []) as Record<string, unknown>[]
const byKey = (writes: Record<string, unknown[]>, table: string) =>
  Object.fromEntries(rowsOf(writes, table).map((r) => [String(r.feed_key), r]))

Deno.test('a run proves every registered feed on chain, spends no provider credits and stays inside its call ceiling', async () => {
  const writes: Record<string, unknown[]> = {}
  // deno-lint-ignore no-explicit-any
  const calls: any[] = []
  const result = await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps({ rpcCall: fakeRpc({}, calls) }))

  eq(result.job, 'rwa_yield')
  // Keyless sources only: this lane never bills a provider.
  eq(result.credits, 0)
  eq(result.error, undefined)
  eq(result.capturedAt, HOUR)
  eq(result.feeds, RWA_YIELD_FEEDS.length)
  eq(result.validated, RWA_YIELD_FEEDS.length)
  eq(result.refused, 0)
  // 1 directory + 2 per feed + 3 benchmarks + 2 EDGAR.
  assert((result.calls as number) <= 1 + RWA_YIELD_FEEDS.length * 2 + 4 + 2)
  // Two batched RPC reads per feed, never one call per round.
  eq(calls.length, RWA_YIELD_FEEDS.length * 2)

  // Every feed is a NAV row, and the advertised-only fund adds a yield row.
  eq(rowsOf(writes, NAV_TABLE).length, RWA_YIELD_FEEDS.length)
  eq(rowsOf(writes, YIELD_TABLE).length, RWA_YIELD_FEEDS.length + 1)
  assert(rowsOf(writes, BENCHMARK_TABLE).length >= 3)

  // Provenance travels with every stored figure.
  for (const row of rowsOf(writes, NAV_TABLE)) {
    eq(row.captured_at, HOUR)
    assert(row.fetched_at, 'no fetched time')
    assert(row.source_url, 'no source url')
    assert(String(row.scope).length > 40, 'no scope string')
    assert(String(row.time_meaning).length > 40, 'no time meaning')
    // The aggregator's own clock, not our capture hour.
    assert(row.nav_observed_at !== row.captured_at)
  }
  for (const row of rowsOf(writes, YIELD_TABLE)) assert(String(row.total_return_limit).includes('not total return'))
})

Deno.test('a feed whose on-chain description disagrees with the mirror is stored refused and never as a nav', async () => {
  const writes: Record<string, unknown[]> = {}
  const result = await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps({
    // The real 2026-09-16 disagreement, applied to a registered feed.
    rpcCall: fakeRpc({ wtgxx: { description: 'WTGXX NAV per Share' } }),
  }))
  eq(result.refused, 1)
  eq(result.validated, RWA_YIELD_FEEDS.length - 1)

  const row = byKey(writes, NAV_TABLE).wtgxx
  eq(row.validation_state, 'refused')
  eq(row.validation_reason, 'description_mismatch')
  // No NAV is stored for a feed we could not prove.
  eq(row.nav, undefined)
  eq(row.staleness, 'unknown')
  // The disagreement itself is retained for review.
  eq(row.on_chain_description, 'WTGXX NAV per Share')
  // The list is never shortened by a failure.
  eq(rowsOf(writes, NAV_TABLE).length, RWA_YIELD_FEEDS.length)
})

Deno.test('a falling nav is stored as review with no figure rather than as a negative yield', async () => {
  const writes: Record<string, unknown[]> = {}
  await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps({ rpcCall: fakeRpc({ crdyx: { navs: FALLING } }) }))
  const row = byKey(writes, YIELD_TABLE).crdyx
  eq(row.realized_state, 'review_declining')
  eq(row.realized_annualized_pct, null)
  eq(row.realized_reason, 'unexplained_nav_decline')
  assert(Number(row.realized_declines) > 0)
  // No spread either: half a comparison is not a comparison.
  eq(row.spread_pct, null)
  // Private credit is given no benchmark at all, with its reason stated.
  eq(row.benchmark_key, null)
  eq(row.benchmark_reason, 'no_free_benchmark_for_private_credit')
})

Deno.test('a flat nav stores a realized yield of exactly zero instead of a blank', async () => {
  const writes: Record<string, unknown[]> = {}
  await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps({ rpcCall: fakeRpc({ vbill: { navs: FLAT } }) }))
  const row = byKey(writes, YIELD_TABLE).vbill
  eq(row.realized_state, 'published')
  // The measurement is zero, and zero is stored. Null here would be a defect.
  eq(row.realized_annualized_pct, 0)
  assert(row.realized_annualized_pct !== null)
  // A published zero still gets its benchmark and therefore a real spread.
  eq(row.benchmark_key, 'us_treasury_bill_3m')
  eq(row.benchmark_pct, 4.11)
  eq(row.spread_pct, -4.11)
})

Deno.test('a euro fund is stored against the euro rate and never against a united states bill', async () => {
  const writes: Record<string, unknown[]> = {}
  await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps())
  const stored = byKey(writes, YIELD_TABLE)
  for (const feed of RWA_YIELD_FEEDS.filter((f) => f.currency === 'EUR')) {
    const row = stored[feed.key]
    eq(row.currency, 'EUR')
    eq(row.benchmark_key, 'estr')
    eq(row.benchmark_currency, 'EUR')
    eq(row.benchmark_pct, 2.19)
    assert(row.benchmark_key !== 'us_treasury_bill_3m')
  }
  // The dollar side keeps its own rates, including the one stated reference.
  eq(stored.jaaa.benchmark_key, 'sofr')
  eq(stored.jaaa.benchmark_pct, 3.64)
  eq(stored.ustb.benchmark_key, 'us_treasury_bill_3m')
  // A benchmark row is never written with a currency other than its own.
  for (const row of rowsOf(writes, BENCHMARK_TABLE)) {
    eq(row.currency, row.benchmark_key === 'estr' ? 'EUR' : 'USD')
  }
})

Deno.test('the advertised yield is read from the filing as of its report date', async () => {
  const writes: Record<string, unknown[]> = {}
  const result = await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps())
  eq(result.advertised, 1)
  const benji = byKey(writes, YIELD_TABLE).benji
  // 0.0357 dated 2026-08-31, not the 0.0355 that leads the document.
  eq(Number(Number(benji.advertised_pct).toFixed(4)), 3.57)
  eq(benji.advertised_observed_at, '2026-08-31')
  eq(benji.advertised_reason, null)
  // There is no NAV feed for this fund, so the realized side says so plainly.
  eq(benji.realized_state, 'insufficient_history')
  eq(benji.realized_reason, 'no_nav_feed')
  eq(benji.realized_annualized_pct, null)
  // A registered NAV feed publishes no advertised figure anywhere free.
  eq(byKey(writes, YIELD_TABLE).ustb.advertised_reason, 'advertised_not_published')
})

Deno.test('a directory that does not answer leaves every feed a row with a stated reason', async () => {
  const writes: Record<string, unknown[]> = {}
  const result = await captureRwaYield(fakeDb({}, writes), ctxFor, NOW, deps({ fetchText: fakeFetch(null) }))
  eq(result.partial, 'directory_unavailable')
  eq(result.validated, 0)
  eq(result.refused, RWA_YIELD_FEEDS.length)
  // A failure never empties the list.
  eq(rowsOf(writes, NAV_TABLE).length, RWA_YIELD_FEEDS.length)
  for (const row of rowsOf(writes, NAV_TABLE)) {
    eq(row.validation_state, 'refused')
    eq(row.validation_reason, 'directory_unavailable')
  }
  eq(result.error, undefined)
})

Deno.test('the lane skips inside its own hour and when an operator disables it', async () => {
  const already = { [NAV_TABLE]: [{ feed_key: 'ustb', captured_at: HOUR }] }
  const within = await captureRwaYield(fakeDb(already, {}), ctxFor, NOW, deps())
  eq(within.skipped, 'within_cadence')
  eq(within.rows, 0)

  const disabled = await captureRwaYield(fakeDb({}, {}), ctxFor, NOW, deps({
    policy: [{ provider: 'chainlink', feature: 'rwa_yield', enabled: false }],
  }))
  eq(disabled.skipped, 'policy_disabled')
  eq(disabled.rows, 0)

  // A zero call budget stops the run before it reaches the network.
  const broke = await captureRwaYield(fakeDb({}, {}), () => ({ maxCalls: 0 }), NOW, deps())
  eq(broke.skipped, 'call_budget')
})

Deno.test('the lane is reachable through the shared capture op surface', async () => {
  assert(typeof RWA_YIELD_CAPTURE_OPS.rwa_yield === 'function')
  const writes: Record<string, unknown[]> = {}
  // The CoinMarketCap plan argument is accepted and ignored: no credits here.
  const result = await RWA_YIELD_CAPTURE_OPS.rwa_yield(fakeDb({}, writes), ctxFor, NOW, 'basic', deps())
  eq(result.credits, 0)
  eq(result.job, 'rwa_yield')
  assert(RWA_FEED_BY_KEY.eutbl.currency === 'EUR')
})
