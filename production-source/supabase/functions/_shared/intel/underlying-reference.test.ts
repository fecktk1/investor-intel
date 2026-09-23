import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  CHAINLINK_EQUITY_FEEDS, EXCLUDED_REFERENCE_TICKERS, REFERENCE_CHAINS, REFERENCE_VERIFIED_AT, FEED_HOURS,
  IN_SESSION_GRACE_SECONDS, OFF_SESSION_MAX_AGE_SECONDS,
  mapUnderlyingTicker, isUsExchange, tradfiTickers, readChainlinkAsOf, chainlinkReferenceSource,
  referenceGap, resolveUnderlyingReferences, assetReferenceColumns, tokenReferenceColumns, observationRow,
  type EquityFeed, type ReferenceReading,
} from './underlying-reference.ts'
import { usEquitySessionAt, US_EQUITY_SESSIONS } from './investigation-sessions.ts'

// ─── ABI fakes, shaped like an aggregator's answers ───────────────────────────

const word = (value: bigint | number): string => BigInt(value).toString(16).padStart(64, '0')
function encodeString(value: string): string {
  const bytes = [...value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return '0x' + word(32) + word(value.length) + bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
}
function encodeRound(roundId: bigint, answer: bigint, updatedAt: number): string {
  return '0x' + word(roundId) + word(answer) + word(0) + word(updatedAt) + word(roundId)
}
const PHASE = 5n << 64n

/** A fake aggregator: `rounds` maps an aggregator round number to [answer, updatedAt].
 * Answers eth_call by selector, so the reader's own batching is exercised. */
function fakeAggregator(options: { description: string; decimals?: number; rounds: Record<number, [number, number]> }) {
  const calls: string[] = []
  const latest = Math.max(...Object.keys(options.rounds).map(Number))
  const rpc = (_url: string, body: unknown, _timeout: number): Promise<unknown> => {
    // deno-lint-ignore no-explicit-any
    const batch = (Array.isArray(body) ? body : [body]) as any[]
    return Promise.resolve(batch.map((entry) => {
      const data = String(entry.params?.[0]?.data ?? '')
      calls.push(data.slice(0, 10))
      const round = (n: number) => {
        const r = options.rounds[n]
        return r ? encodeRound(PHASE + BigInt(n), BigInt(Math.round(r[0] * 1e8)), r[1]) : encodeRound(PHASE + BigInt(n), 0n, 0)
      }
      if (data === '0x7284e416') return { id: entry.id, result: encodeString(options.description) }
      if (data === '0x313ce567') return { id: entry.id, result: '0x' + word(options.decimals ?? 8) }
      if (data === '0xfeaf968c') return { id: entry.id, result: round(latest) }
      if (data.startsWith('0x9a6fc8f5')) return { id: entry.id, result: round(Number(BigInt('0x' + data.slice(10)) - PHASE)) }
      return { id: entry.id, error: { message: 'execution reverted' } }
    }))
  }
  return { rpc, calls }
}

const NVDA = CHAINLINK_EQUITY_FEEDS.NVDA
const at = (iso: string) => Date.parse(iso)
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000)

// ─── The registry ─────────────────────────────────────────────────────────────

Deno.test('registry: every entry is a verifiable AggregatorV3 proxy with its band and heartbeat', () => {
  eq(REFERENCE_VERIFIED_AT, '2026-09-23')
  const entries = Object.entries(CHAINLINK_EQUITY_FEEDS)
  eq(entries.length, 12)
  const proxies = new Set<string>()
  for (const [key, feed] of entries) {
    eq(feed.ticker, key)
    assert(/^0x[0-9a-f]{40}$/.test(feed.proxy), `${key} proxy is lower-case hex`)
    assert(!proxies.has(feed.proxy), `${key} proxy is unique`)
    proxies.add(feed.proxy)
    assert(Object.hasOwn(REFERENCE_CHAINS, feed.chain), `${key} chain has an RPC`)
    eq(feed.decimals, 8)
    assert(feed.deviationPct > 0 && feed.deviationPct <= 1, `${key} band is a percent`)
    eq(feed.heartbeatSeconds, 86400)
    assert((FEED_HOURS as readonly string[]).includes(feed.hours))
    // The description is the chain's own string, in one of the two shapes the
    // equity feeds use; anything else would never pass the on-chain proof.
    assert(feed.description === `${key} / USD` || feed.description === `${key}-USD (24/5)`, `${key} description`)
    eq(feed.hours === 'us_equities_24_5', feed.description.endsWith('(24/5)'))
    assert(feed.assetType === 'stock' || feed.assetType === 'etf')
  }
  eq(CHAINLINK_EQUITY_FEEDS.SPY.assetType, 'etf')
  eq(CHAINLINK_EQUITY_FEEDS.QQQ.assetType, 'etf')
  // Every RPC is https and keyless.
  for (const chain of Object.values(REFERENCE_CHAINS)) assert(/^https:\/\/[a-z0-9.-]+\/?$/.test(chain.rpcUrl))
})

Deno.test('registry: SPCX and the tokenised-equity-only tickers are excluded, never registered', () => {
  for (const ticker of ['SPCX', 'CRCL', 'INTC', 'SNDK']) {
    assert(!Object.hasOwn(CHAINLINK_EQUITY_FEEDS, ticker), `${ticker} is not in the registry`)
    assert(Object.hasOwn(EXCLUDED_REFERENCE_TICKERS, ticker), `${ticker} says why`)
  }
  eq(EXCLUDED_REFERENCE_TICKERS.SPCX, 'pre_ipo_venue_price')
})

Deno.test('registry verification: description, decimals and a positive latest round prove a feed', async () => {
  const chain = fakeAggregator({ description: 'NVDA / USD', rounds: { 100: [225.57, sec('2026-09-23T18:19:09Z')] } })
  const reading = await readChainlinkAsOf(NVDA, at('2026-09-23T18:30:00Z'), { rpcCall: chain.rpc })
  eq(reading.state, 'observed')
  eq(reading.reason, null)
  eq(reading.onChainDescription, 'NVDA / USD')
  eq(reading.price, 225.57)
  eq(reading.roundUpdatedAt, '2026-09-23T18:19:09.000Z')
  eq(reading.ageSeconds, 651)
  eq(reading.session, 'regular')
  eq(reading.network, 'arbitrum')
  eq(reading.deviationPct, 0.5)
  // The three proof calls, and nothing else, when the latest round predates the instant.
  eq(chain.calls.sort(), ['0x313ce567', '0x7284e416', '0xfeaf968c'])

  // A swapped address answers another feed's description: refused, and what the
  // chain said is kept so the disagreement is reviewable.
  const wrong = fakeAggregator({ description: 'NVDA-USD (24/5)', rounds: { 100: [225.57, sec('2026-09-23T18:19:09Z')] } })
  const refused = await readChainlinkAsOf(NVDA, at('2026-09-23T18:30:00Z'), { rpcCall: wrong.rpc })
  eq(refused.state, 'unavailable')
  eq(refused.reason, 'feed_identity_not_proved')
  eq(refused.detail, 'description_mismatch')
  eq(refused.onChainDescription, 'NVDA-USD (24/5)')
  eq(refused.price, null)
  const decimals = await readChainlinkAsOf(NVDA, at('2026-09-23T18:30:00Z'), { rpcCall: fakeAggregator({ description: 'NVDA / USD', decimals: 18, rounds: { 1: [1, 1] } }).rpc })
  eq(decimals.reason, 'feed_identity_not_proved')
  eq(decimals.detail, 'decimals_mismatch')
})

// Opt-in: `INTEL_LIVE_RPC=1 deno test --allow-net --allow-env --allow-read --no-check underlying-reference.test.ts`
// proves every registry entry against the chain itself.
Deno.test({
  name: 'registry verification, LIVE: every entry answers its description, decimals and a round',
  ignore: Deno.env.get('INTEL_LIVE_RPC') !== '1',
  async fn() {
    const now = Date.now()
    const results = await Promise.all(Object.values(CHAINLINK_EQUITY_FEEDS).map((feed) => readChainlinkAsOf(feed, now, { timeoutMs: 12000 })))
    for (const reading of results) {
      assert(reading.state !== 'unavailable', `${reading.ticker}: ${reading.reason} ${reading.detail}`)
      eq(reading.onChainDescription, CHAINLINK_EQUITY_FEEDS[reading.ticker].description)
      assert((reading.price ?? 0) > 0)
    }
  },
})

// ─── The US session calendar ──────────────────────────────────────────────────

Deno.test('session: the four capture minutes on a September weekday (EDT)', () => {
  // 2026-09-23 is a Wednesday. The lane runs at :47 of 02, 08, 14 and 20 UTC.
  eq(usEquitySessionAt(at('2026-09-23T14:47:00Z')).session, 'regular')      // 10:47 New York
  eq(usEquitySessionAt(at('2026-09-23T08:47:00Z')).session, 'pre_market')   // 04:47
  eq(usEquitySessionAt(at('2026-09-23T20:47:00Z')).session, 'after_hours')  // 16:47
  eq(usEquitySessionAt(at('2026-09-23T02:47:00Z')).session, 'closed')       // 22:47 the evening before
  // The session edges are half-open: 09:30 is regular, 16:00 is after-hours, 20:00 is closed, 04:00 is pre-market.
  eq(usEquitySessionAt(at('2026-09-23T13:30:00Z')).session, 'regular')
  eq(usEquitySessionAt(at('2026-09-23T13:29:59Z')).session, 'pre_market')
  eq(usEquitySessionAt(at('2026-09-23T20:00:00Z')).session, 'after_hours')
  eq(usEquitySessionAt(at('2026-09-24T00:00:00Z')).session, 'closed')
  eq(usEquitySessionAt(at('2026-09-23T08:00:00Z')).session, 'pre_market')
})

Deno.test('session: standard time moves the same UTC minute into a different session', () => {
  // 2026-12-01 (EST, UTC-5): 20:47 UTC is 15:47 in New York, still regular.
  eq(usEquitySessionAt(at('2026-12-01T20:47:00Z')).session, 'regular')
  eq(usEquitySessionAt(at('2026-12-01T08:47:00Z')).session, 'closed')      // 03:47
})

Deno.test('session: weekend, a 2026 holiday and an early close', () => {
  eq(usEquitySessionAt(at('2026-09-26T15:00:00Z')).session, 'weekend')     // Saturday
  eq(usEquitySessionAt(at('2026-09-27T23:00:00Z')).session, 'weekend')     // Sunday 19:00 in New York
  // Thanksgiving 2026 and Labor Day 2026 are full-day holidays.
  eq(usEquitySessionAt(at('2026-11-26T15:00:00Z')).session, 'holiday')
  eq(usEquitySessionAt(at('2026-09-07T14:47:00Z')).session, 'holiday')
  // Friday 27 November 2026 closes at 13:00; the late session ends at 17:00.
  const early = usEquitySessionAt(at('2026-11-27T17:30:00Z'))             // 12:30 EST
  eq(early.session, 'regular')
  eq(early.earlyClose, true)
  eq(usEquitySessionAt(at('2026-11-27T18:30:00Z')).session, 'after_hours') // 13:30
  eq(usEquitySessionAt(at('2026-11-27T22:30:00Z')).session, 'closed')      // 17:30
  // 2027 is covered too: Good Friday is 26 March 2027.
  eq(usEquitySessionAt(at('2027-03-26T15:00:00Z')).session, 'holiday')
  // Outside the covered years a weekday is not asserted; a weekend still is.
  eq(usEquitySessionAt(at('2029-03-06T15:00:00Z')).session, 'unknown')
  eq(usEquitySessionAt(at('2029-03-03T15:00:00Z')).session, 'weekend')
  eq(usEquitySessionAt(NaN).session, 'unknown')
  for (const probe of ['2026-01-01T15:00:00Z', '2026-06-19T15:00:00Z']) assert(US_EQUITY_SESSIONS.includes(usEquitySessionAt(at(probe)).session))
})

// ─── The band rule ────────────────────────────────────────────────────────────

Deno.test('within band: a gap inside the feed band is not distinguishable, outside it is a gap', () => {
  const ref = { state: 'observed' as const, price: 100, deviationPct: 0.5 }
  const inside = referenceGap(100.4, ref)
  eq(Math.round(inside.bps! * 1000) / 1000, 40)
  eq(inside.withinBand, true)
  const edge = referenceGap(99.5, ref)
  eq(Math.round(edge.bps! * 1000) / 1000, -50)
  eq(edge.withinBand, true)
  const outside = referenceGap(100.6, ref)
  eq(outside.withinBand, false)
  eq(referenceGap(99.3, ref).withinBand, false)
  // A tighter feed calls the same gap distinguishable.
  eq(referenceGap(100.4, { ...ref, deviationPct: 0.3 }).withinBand, false)
  // A source with no band reports the gap and no verdict.
  eq(referenceGap(100.4, { ...ref, deviationPct: null }).withinBand, null)
  // No reference, a stale one, or no price: nothing at all, never a zero.
  eq(referenceGap(100.4, { ...ref, state: 'stale' as const }), { bps: null, withinBand: null })
  eq(referenceGap(null, ref), { bps: null, withinBand: null })
  eq(referenceGap(100.4, null), { bps: null, withinBand: null })
})

// ─── Ticker mapping refusals ──────────────────────────────────────────────────

Deno.test('mapping: exact symbol only, and every piece of evidence must agree', () => {
  const stock = (symbol: string, assetType = 'stock') => ({ symbol, assetType })
  eq(mapUnderlyingTicker(stock('NVDA'), { primaryExchange: 'Nasdaq', registrantTickers: ['NVDA'], tradfiTickers: ['NVDA'] }), { state: 'mapped', ticker: 'NVDA', reason: null })
  // Name similarity is never a join: a wrapper-like symbol, a company name and a
  // case-folded ticker all miss.
  eq(mapUnderlyingTicker(stock('NVDAX')).state, 'no_reference')
  eq(mapUnderlyingTicker(stock('Nvidia Corp')).state, 'no_reference')
  eq(mapUnderlyingTicker(stock('nvda')).state, 'no_reference')
  eq(mapUnderlyingTicker(stock('NVDA ')).state, 'mapped')
  // A non-US primary listing is refused even when the ticker matches.
  eq(mapUnderlyingTicker(stock('TSLA'), { primaryExchange: 'London Stock Exchange' }), { state: 'mapping_refused', ticker: 'TSLA', reason: 'not_a_us_listing' })
  eq(mapUnderlyingTicker(stock('TSLA'), { primaryExchange: 'Deutsche Boerse Xetra' }).reason, 'not_a_us_listing')
  // SEC registrant tickers and the quotes payload's tradfi tickers must agree.
  eq(mapUnderlyingTicker(stock('META'), { registrantTickers: ['FB'] }).reason, 'registrant_tickers_disagree')
  eq(mapUnderlyingTicker(stock('META'), { tradfiTickers: ['METAX'] }).reason, 'tradfi_ticker_disagrees')
  // An ETF ticker carried as a stock is not the same instrument.
  eq(mapUnderlyingTicker(stock('QQQ', 'stock')).reason, 'asset_type_disagrees')
  eq(mapUnderlyingTicker(stock('QQQ', 'etf'), { primaryExchange: 'Nasdaq' }).state, 'mapped')
  // SpaceX has a Chainlink feed, from a pre-IPO venue: no stock reference.
  eq(mapUnderlyingTicker(stock('SPCX')), { state: 'no_reference', ticker: 'SPCX', reason: 'pre_ipo_venue_price' })
  eq(mapUnderlyingTicker(stock('CRCL'), { primaryExchange: 'New York Stock Exchange' }).reason, 'only_a_tokenised_equity_feed')
  // No feed at all, and a commodity, which a stock reference does not apply to.
  eq(mapUnderlyingTicker(stock('AMD'), { primaryExchange: 'Nasdaq' }), { state: 'no_reference', ticker: 'AMD', reason: 'no_feed_for_ticker' })
  eq(mapUnderlyingTicker({ symbol: 'GOLD', assetType: 'commodity' }).state, 'not_applicable')
  // Absent evidence is not disagreement.
  eq(mapUnderlyingTicker(stock('GME'), { primaryExchange: null, registrantTickers: [], tradfiTickers: null }).state, 'mapped')
})

Deno.test('mapping evidence: US exchanges and the tradfi ticker list', () => {
  for (const name of ['Nasdaq', 'New York Stock Exchange', 'NYSE Arca, Inc.', 'NYSE American, LLC', 'Cboe BZX']) assert(isUsExchange(name), name)
  for (const name of ['London Stock Exchange', 'Euronext Amsterdam', 'Binance', '']) assert(!isUsExchange(name), name)
  eq(tradfiTickers({ tradfi_markets: [{ ticker: 'NVDA', exchange: { name: 'Binance' }, market_url: 'https://www.binance.com/en/stocks/EQ_NVDA' }] }), ['NVDA'])
  eq(tradfiTickers({ tradfi_markets: [] }), null)
  eq(tradfiTickers({}), null)
})

// ─── The clock and the round walk ─────────────────────────────────────────────

Deno.test('as of: a round written after the wrapper prices is walked back, bounded', async () => {
  // Wrapper prices observed 08:45:59 (pre-market). The feed's last round of the
  // previous session was 19:58, and two rounds were written after the open.
  const chain = fakeAggregator({
    description: 'NVDA / USD',
    rounds: { 97: [226.1, sec('2026-09-22T17:02:00Z')], 98: [228.9, sec('2026-09-22T19:58:00Z')], 99: [227.4, sec('2026-09-23T13:31:00Z')], 100: [225.57, sec('2026-09-23T18:19:09Z')] },
  })
  const reading = await readChainlinkAsOf(NVDA, at('2026-09-23T08:45:59Z'), { rpcCall: chain.rpc })
  eq(reading.state, 'observed')
  eq(reading.price, 228.9)
  eq(reading.roundUpdatedAt, '2026-09-22T19:58:00.000Z')
  eq(reading.session, 'pre_market')
  eq(reading.ageSeconds, sec('2026-09-23T08:45:59Z') - sec('2026-09-22T19:58:00Z'))
  assert(reading.roundsRead > 1)
  // Nothing old enough inside the walk: unavailable with its reason, never the newest round instead.
  const young = fakeAggregator({ description: 'NVDA / USD', rounds: { 1: [225.57, sec('2026-09-23T18:19:09Z')] } })
  const missing = await readChainlinkAsOf(NVDA, at('2026-09-23T08:45:59Z'), { rpcCall: young.rpc })
  eq(missing.state, 'unavailable')
  eq(missing.reason, 'round_at_observation_not_read')
  eq(missing.price, null)
})

Deno.test('staleness: a feed that stopped during the session is not used; a weekend round is', async () => {
  const stopped = fakeAggregator({ description: 'NVDA / USD', rounds: { 1: [225.57, sec('2026-09-21T15:00:00Z')] } })
  const inSession = await readChainlinkAsOf(NVDA, at('2026-09-23T14:47:00Z'), { rpcCall: stopped.rpc })
  eq(inSession.state, 'stale')
  eq(inSession.reason, 'stale_in_session')
  assert(inSession.ageSeconds! > NVDA.heartbeatSeconds + IN_SESSION_GRACE_SECONDS)
  // Friday's last round read on Sunday is the last regular-session level.
  const friday = fakeAggregator({ description: 'NVDA / USD', rounds: { 1: [225.57, sec('2026-09-25T19:59:00Z')] } })
  const weekend = await readChainlinkAsOf(NVDA, at('2026-09-27T20:45:59Z'), { rpcCall: friday.rpc })
  eq(weekend.state, 'observed')
  eq(weekend.session, 'weekend')
  // A round older than any scheduled closure explains is stale even off-session.
  const ancient = fakeAggregator({ description: 'NVDA / USD', rounds: { 1: [225.57, sec('2026-09-15T19:59:00Z')] } })
  const old = await readChainlinkAsOf(NVDA, at('2026-09-27T20:45:59Z'), { rpcCall: ancient.rpc })
  eq(old.reason, 'stale_off_session')
  assert(old.ageSeconds! > OFF_SESSION_MAX_AGE_SECONDS)
})

// ─── A failed read ────────────────────────────────────────────────────────────

Deno.test('a failed RPC read is an honest reason, never a zero, on every row it touches', async () => {
  const down = (_url: string, _body: unknown, _t: number): Promise<unknown> => Promise.reject(new Error('rpc_http_503'))
  const source = chainlinkReferenceSource({ rpcCall: down })
  const { outcomes, reads } = await resolveUnderlyingReferences(
    [{ rwaId: '2', symbol: 'NVDA', assetType: 'stock', observedAt: '2026-09-23T08:45:59Z' }],
    new Map([['2', { primaryExchange: 'Nasdaq' }]]), source,
  )
  eq(reads, 1)
  const outcome = outcomes.get('2')!
  eq(outcome.mapping.state, 'mapped')
  eq(outcome.reading?.state, 'unavailable')
  eq(outcome.reading?.reason, 'feed_read_failed')
  eq(outcome.reading?.detail, 'rpc_http_503')
  eq(outcome.reading?.price, null)
  const asset = assetReferenceColumns(outcome, 228.9, '2026-09-23T19:30:00.000Z')
  eq(asset.underlying_ref_state, 'unavailable')
  eq(asset.underlying_ref_reason, 'feed_read_failed')
  eq(asset.underlying_ref_price, null)
  eq(asset.underlying_ref_anchor_bps, null)
  eq(asset.underlying_ref_anchor_within_band, null)
  const token = tokenReferenceColumns({ normalised_price: 229.2, wrapper_state: 'liquid' }, outcome)
  assert(Object.values(token).every((v) => v === null))
  const obs = observationRow('2', outcome, { capturedAt: '2026-09-23T14:00:00.000Z', fetchedAt: '2026-09-23T19:30:00.000Z', op: 'rwa_wrapper_reference' })!
  eq(obs.read_state, 'unavailable')
  eq(obs.read_reason, 'feed_read_failed')
  eq(obs.price, null)
  eq(obs.round_updated_at, null)
  eq(obs.session, 'pre_market')
})

Deno.test('rows: an observed reference fills the asset and each eligible wrapper, never an accruing one', async () => {
  const chain = fakeAggregator({ description: 'SPY / USD', rounds: { 1: [770.04, sec('2026-09-23T14:09:13Z')] } })
  const source = chainlinkReferenceSource({ rpcCall: chain.rpc })
  const { outcomes } = await resolveUnderlyingReferences(
    [
      { rwaId: '86', symbol: 'SPY', assetType: 'etf', observedAt: '2026-09-23T14:45:59Z' },
      { rwaId: '1', symbol: 'GOLD', assetType: 'commodity', observedAt: '2026-09-23T14:45:59Z' },
      { rwaId: '9', symbol: 'SPCX', assetType: 'stock', observedAt: '2026-09-23T14:45:59Z' },
      { rwaId: '2', symbol: 'NVDA', assetType: 'stock', observedAt: null },
    ],
    new Map(), source,
  )
  const spy = outcomes.get('86')!
  const asset = assetReferenceColumns(spy, 772.0, '2026-09-23T14:47:01.000Z')
  eq(asset.underlying_ref_state, 'observed')
  eq(asset.underlying_ref_ticker, 'SPY')
  eq(asset.underlying_ref_price, 770.04)
  eq(asset.underlying_ref_feed, 'SPY / USD')
  eq(asset.underlying_ref_network, 'arbitrum')
  eq(asset.underlying_ref_session, 'regular')
  eq(asset.underlying_ref_compared_at, '2026-09-23T14:45:59.000Z')
  eq(asset.underlying_ref_age_s, sec('2026-09-23T14:45:59Z') - sec('2026-09-23T14:09:13Z'))
  eq(Math.round((asset.underlying_ref_anchor_bps as number) * 10) / 10, 25.5)
  eq(asset.underlying_ref_anchor_within_band, true)
  const dear = tokenReferenceColumns({ normalised_price: 775, wrapper_state: 'liquid' }, spy)
  eq(dear.underlying_ref_within_band, false)
  eq(Math.round((dear.underlying_ref_bps as number) * 10) / 10, 64.4)
  eq(dear.underlying_ref_session, 'regular')
  const thin = tokenReferenceColumns({ normalised_price: 770.5, wrapper_state: 'too_thin_to_anchor' }, spy)
  eq(thin.underlying_ref_within_band, true)
  const accruing = tokenReferenceColumns({ normalised_price: 800, wrapper_state: 'accrues_in_price' }, spy)
  eq(accruing.underlying_ref_bps, null)
  eq(accruing.underlying_ref_within_band, null)
  const noUnit = tokenReferenceColumns({ normalised_price: null, wrapper_state: 'unit_not_established' }, spy)
  eq(noUnit.underlying_ref_bps, null)
  // A commodity is untouched; SpaceX says why it has no reference; an asset with
  // no provider clock is not read "now" instead.
  assert(Object.values(assetReferenceColumns(outcomes.get('1')!, 4300, 'x')).every((v) => v === null))
  const spcx = assetReferenceColumns(outcomes.get('9')!, 154, 'x')
  eq(spcx.underlying_ref_state, 'no_reference')
  eq(spcx.underlying_ref_reason, 'pre_ipo_venue_price')
  eq(observationRow('9', outcomes.get('9')!, { capturedAt: 'x', fetchedAt: 'x', op: 'rwa_wrappers' }), null)
  const clockless = assetReferenceColumns(outcomes.get('2')!, 228, 'x')
  eq(clockless.underlying_ref_state, 'unavailable')
  eq(clockless.underlying_ref_reason, 'wrapper_observation_time_unknown')
})

Deno.test('the source interface: a second provider maps through the same rules', async () => {
  // A stand-in licensed source with no update band. Not a real provider.
  const reading = (ticker: string, asOfMs: number): ReferenceReading => ({
    source: 'chainlink', ticker, state: 'observed', reason: null, detail: null, network: null, address: null, feed: `${ticker} last sale`,
    onChainDescription: null, decimals: null, deviationPct: null, heartbeatSeconds: null, hours: null, roundId: '1', price: 100,
    roundUpdatedAt: new Date(asOfMs).toISOString(), ageSeconds: 0, comparedAt: new Date(asOfMs).toISOString(), session: 'regular', roundsRead: 1,
  })
  const other = {
    id: 'chainlink' as const,
    covers: (ticker: string) => (ticker === 'AMD' ? { assetType: 'stock' } : null),
    readAsOf: (requests: { ticker: string; asOfMs: number }[]) => Promise.resolve(new Map(requests.map((r) => [`${r.ticker}@${r.asOfMs}`, reading(r.ticker, r.asOfMs)]))),
  }
  const { outcomes } = await resolveUnderlyingReferences(
    [{ rwaId: '25', symbol: 'AMD', assetType: 'stock', observedAt: '2026-09-23T14:45:59Z' }, { rwaId: '9', symbol: 'SPCX', assetType: 'stock', observedAt: '2026-09-23T14:45:59Z' }],
    new Map(), other,
  )
  eq(outcomes.get('25')!.reading?.price, 100)
  const gap = tokenReferenceColumns({ normalised_price: 100.4, wrapper_state: 'liquid' }, outcomes.get('25')!)
  eq(gap.underlying_ref_within_band, null)
  // The exclusions hold whatever the source.
  eq(outcomes.get('9')!.mapping.reason, 'pre_ipo_venue_price')
})

// deno-lint-ignore no-unused-vars
const _typecheck: EquityFeed = NVDA
