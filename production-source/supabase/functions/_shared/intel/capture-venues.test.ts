import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { CMC_CAPABILITIES } from '../market-assets/cmc-capabilities.ts'
import {
  captureExchangeReserves, captureVenueShare, aggregateWallets, exchangeFromRow, selectTopExchanges,
  venueRowsFromListings, venueRowsFromDerivatives, venuePolicy, capabilityForPath,
  VENUE_CAPTURE_OPS, VENUE_CAPTURE_OP_NAMES, RESERVE_EXCHANGES, RESERVE_ASSETS_PER_EXCHANGE,
  EXCHANGE_MAP_CAPABILITY, EXCHANGE_LISTINGS_CAPABILITY, EXCHANGE_ASSETS_CAPABILITY, DERIVATIVE_EXCHANGES_CAPABILITY,
} from './capture-venues.ts'
import { utcDate } from './capture-jobs.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const DAY = utcDate(NOW)
const minus = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

/** The exchange lanes resolve their capabilities from the registry by path, so
 * the fixtures follow whatever is registered today and keep passing the day
 * `/v1/exchange/listings/latest` is added. */
const SELECT_CAPABILITY = EXCHANGE_LISTINGS_CAPABILITY ?? EXCHANGE_MAP_CAPABILITY!
const VENUE_CAPABILITY = EXCHANGE_LISTINGS_CAPABILITY ?? DERIVATIVE_EXCHANGES_CAPABILITY!
const ASSETS_CAPABILITY = EXCHANGE_ASSETS_CAPABILITY!

/** `cmcRows` reads a capability's rows from `data` or from `data.<rows>`. */
// deno-lint-ignore no-explicit-any
const listPayload = (name: string, rows: any[]) => {
  const key = CMC_CAPABILITIES[name]?.rows
  return key ? { data: { [key]: rows } } : { data: rows }
}

// deno-lint-ignore no-explicit-any
const exchangeRow = (id: number, volume: number, extra: Record<string, any> = {}) => ({
  id, exchange_id: id, slug: `venue-${id}`, exchange_slug: `venue-${id}`, name: `Venue ${id}`, exchange_name: `Venue ${id}`,
  is_active: 1, num_market_pairs: 100 + id, last_updated: minus(600_000),
  quote: { USD: { volume_24h: volume, last_updated: minus(600_000) } }, ...extra,
})

// deno-lint-ignore no-explicit-any
const wallet = (address: string, symbol: string, cryptoId: number, balance: number, price: number, platform?: Record<string, any>) => ({
  wallet_address: address, balance,
  platform: platform ?? { crypto_id: 1027, symbol: 'ETH', name: 'Ethereum' },
  currency: { crypto_id: cryptoId, symbol, name: symbol, price_usd: price },
})

/** Minimal PostgREST-shaped fake: eq/gt/gte/lte/in filters, order, limit and
 * upsert. Every chain in the jobs ends in `.limit()` or `.upsert()`. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, writes: Record<string, any[]> = {}, upsertError?: string) {
  // deno-lint-ignore no-explicit-any
  const compare = (a: any, b: any) => {
    const [x, y] = [Number(a), Number(b)]
    return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a ?? '').localeCompare(String(b ?? ''))
  }
  return {
    upserts: writes,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      let ordering: { column: string; ascending: boolean } | null = null
      const run = (max: number | null) => {
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => {
            const v = row?.[key]
            if (op === 'eq') return String(v ?? '') === String(operand ?? '')
            if (op === 'gte') return compare(v, operand) >= 0
            if (op === 'lte') return compare(v, operand) <= 0
            return true
          })
        }
        if (ordering) rows.sort((a, b) => compare(a?.[ordering!.column], b?.[ordering!.column]) * (ordering!.ascending ? 1 : -1))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        gte: (k: string, v: any) => { filters.push([k, 'gte', v]); return q },
        // deno-lint-ignore no-explicit-any
        lte: (k: string, v: any) => { filters.push([k, 'lte', v]); return q },
        // deno-lint-ignore no-explicit-any
        order: (column: string, options: any = {}) => { ordering = { column, ascending: options?.ascending !== false }; return q },
        limit: (max: number) => Promise.resolve(run(max)),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => {
          if (upsertError) return Promise.resolve({ error: { message: upsertError } })
          ;(writes[table] ||= []).push(...rows)
          return Promise.resolve({ error: null })
        },
      }
      return q
    },
  }
}

const ctxFor = (name: string, maxCalls: number) => ({ jobName: 'intel-capture', caller: `intel-capture-${name}`, kind: 'job' as const, maxCalls })

/** Twelve venues; the ten largest are the ones the reserve lane must pick. */
const TWELVE_VENUES = Array.from({ length: 12 }, (_, i) => exchangeRow(i + 1, 1e10 - i * 1e8))

// deno-lint-ignore no-explicit-any
function fakeRequest(handlers: Record<string, (params: any) => any>) {
  // deno-lint-ignore no-explicit-any
  const calls: { name: string; params: any }[] = []
  // deno-lint-ignore no-explicit-any
  const request = (name: string, params: any = {}) => {
    calls.push({ name, params })
    const handler = handlers[name]
    return Promise.resolve(handler ? handler(params) : { payload: null, state: 'error', reason: 'unregistered_in_test' })
  }
  return { request, calls }
}

// ─── registry resolution and policy ───────────────────────────────────────────

Deno.test('capabilities resolve by provider path and the ops surface is exactly the two lanes', () => {
  eq(capabilityForPath('/v1/exchange/assets'), 'exchangeAssets')
  eq(capabilityForPath('/v1/exchange/map'), 'exchangeMap')
  eq(capabilityForPath('/v5/exchange/derivatives/list'), 'derivativeExchanges')
  eq(capabilityForPath('/nope'), null)
  eq(VENUE_CAPTURE_OP_NAMES, ['exchange_reserves', 'venue_share'])
  eq(Object.keys(VENUE_CAPTURE_OPS).sort(), ['exchange_reserves', 'venue_share'])
})

Deno.test('venue policy defaults both lanes to daily and honours the policy row', () => {
  eq(venuePolicy([], 'exchange_reserves'), { enabled: true, cadenceSeconds: 86400, minPlan: null })
  eq(venuePolicy([], 'venue_share').cadenceSeconds, 86400)
  // The seeded venue_share row is weekly; the job must obey whatever it says.
  eq(venuePolicy([{ feature: 'venue_share', cadence_seconds: 604800 }], 'venue_share').cadenceSeconds, 604800)
  eq(venuePolicy([{ feature: 'exchange_reserves', cadence_seconds: 3600 }], 'exchange_reserves').cadenceSeconds, 3600)
  eq(venuePolicy([{ feature: 'exchange_reserves', cadence_seconds: 86400, enabled: false }], 'exchange_reserves').enabled, false)
})

// ─── pure helpers ─────────────────────────────────────────────────────────────

Deno.test('exchange rows are read from either the listing or the map shape', () => {
  eq(exchangeFromRow({ id: 270, slug: 'binance', quote: { volume_24h: 5e9 }, num_market_pairs: 1800 }),
    { exchangeId: 270, slug: 'binance', name: null, volume24h: 5e9, numMarketPairs: 1800 })
  eq(exchangeFromRow({ exchange_id: 302, exchange_slug: 'okx', exchange_name: 'OKX', quote: {} })?.volume24h, null)
  eq(exchangeFromRow({ slug: 'no-id' }), null)
  eq(exchangeFromRow({ id: 0 }), null)
})

Deno.test('wallet aggregation sums balances and USD across wallets, counts distinct wallets and splits by platform', () => {
  const assets = aggregateWallets([
    wallet('0xaaa', 'USDT', 825, 100, 1.0),
    wallet('0xbbb', 'USDT', 825, 50, 1.0),
    wallet('0xaaa', 'USDT', 825, 25, 1.0),                                        // same wallet again: one wallet, 175 total
    wallet('0xccc', 'USDT', 825, 10, 1.0, { crypto_id: 1839, symbol: 'BNB', name: 'BNB' }),  // a second platform is its own row
    wallet('0xddd', 'BTC', 1, 2, 60000),
    { balance: 3, currency: { crypto_id: 1, symbol: 'BTC', price_usd: 60000 }, platform: null }, // no wallet address
    { balance: 1, currency: {}, platform: null },                                  // no asset identity: dropped
  ])
  const usdt = assets.find((a) => a.symbol === 'USDT' && a.platformSymbol === 'ETH')!
  eq(usdt.providerId, '825'); eq(usdt.balance, 175); eq(usdt.usdValue, 175); eq(usdt.walletCount, 2)
  const bnbUsdt = assets.find((a) => a.platformSymbol === 'BNB')!
  eq(bnbUsdt.balance, 10); eq(bnbUsdt.walletCount, 1)
  // A holding with no reported platform folds into '' — the unique index does the same.
  const btcNoPlatform = assets.find((a) => a.symbol === 'BTC' && a.platformSymbol === '')!
  eq(btcNoPlatform.balance, 3); eq(btcNoPlatform.usdValue, 180000); eq(btcNoPlatform.walletCount, 1)
  const btc = assets.find((a) => a.symbol === 'BTC' && a.platformSymbol === 'ETH')!
  eq(btc.usdValue, 120000)
  eq(assets.length, 4)
})

Deno.test('venue rows keep only reported figures and never invent a derivatives row', () => {
  const spotOnly = venueRowsFromListings([{ id: 270, slug: 'binance', num_market_pairs: 1800, quote: { volume_24h: 9e9, last_updated: minus(600_000) } }])
  eq(spotOnly.length, 1)
  eq(spotOnly[0].kind, 'spot'); eq(spotOnly[0].volume24h, 9e9); eq(spotOnly[0].numMarketPairs, 1800)
  eq(spotOnly[0].openInterest, null); eq(spotOnly[0].observedAt, minus(600_000))
  const both = venueRowsFromListings([{ id: 302, slug: 'okx', quote: { volume_24h: 4e9, derivative_volume_24h: 2e9, open_interest: 7e8 } }])
  eq(both.map((r) => r.kind), ['spot', 'derivatives'])
  eq(both[1].volume24h, 2e9); eq(both[1].openInterest, 7e8)
  // The spot volume is never reused as a derivative volume.
  eq(both[0].volume24h, 4e9)
  const derivatives = venueRowsFromDerivatives([{ exchange_id: 302, exchange_slug: 'okx', num_market_pairs: 300, quote: { volume_24h: 2e9, open_interest: 7e8 } }])
  eq(derivatives.length, 1); eq(derivatives[0].kind, 'derivatives'); eq(derivatives[0].numMarketPairs, 300)
})

Deno.test('exchange selection takes the largest venues and drops a delisted one', async () => {
  const rows = [...TWELVE_VENUES, exchangeRow(99, 9e12, { is_active: 0 })]
  const { request, calls } = fakeRequest({ [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, rows), state: 'fresh', reason: null }) })
  const result = await selectTopExchanges(ctxFor, { request, policy: [] }, RESERVE_EXCHANGES)
  eq(result.credits, 1); eq(calls.length, 1); eq(result.exchanges.length, 10)
  eq(result.exchanges[0].exchangeId, 1)
  eq(result.exchanges.at(-1)?.exchangeId, 10)
  // The map has no volume field to sort by, so a delisted venue is the only
  // thing the selection can exclude on its own; the listing sorts by volume.
  if (SELECT_CAPABILITY === EXCHANGE_MAP_CAPABILITY) assert(!result.exchanges.some((e) => e.exchangeId === 99))
})

// ─── exchange reserves ────────────────────────────────────────────────────────

Deno.test('exchange reserves capture one row per exchange and asset for the ten largest venues', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request, calls } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, TWELVE_VENUES), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: (params: Record<string, unknown>) => ({
      payload: { data: [
        wallet(`0x${params.id}a`, 'USDT', 825, 1000, 1),
        wallet(`0x${params.id}b`, 'USDT', 825, 500, 1),
        wallet(`0x${params.id}c`, 'BTC', 1, 1, 60000),
      ] }, state: 'fresh', reason: null,
    }),
  })
  const result = await captureExchangeReserves(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.error, undefined); eq(result.skipped, undefined)
  // 1 selection call + 1 exchangeAssets call per venue.
  eq(result.credits, 11); eq(calls.length, 11)
  eq(result.exchanges, 10); eq(result.snapshotDate, DAY)
  eq(result.rows, 20)
  const rows = writes.intel_exchange_reserve_snapshots as Record<string, unknown>[]
  eq(rows.length, 20)
  const first = rows.find((r) => r.exchange_id === 1 && r.symbol === 'USDT')!
  eq(first.snapshot_date, DAY); eq(first.provider_id, '825'); eq(first.platform_symbol, 'ETH')
  eq(first.exchange_slug, 'venue-1'); eq(first.balance, 1500); eq(first.usd_value, 1500); eq(first.wallet_count, 2)
  eq((first.raw as Record<string, unknown>).priceUsd, 1)
  // Largest holding first, so the 250-asset bound drops the smallest.
  eq(rows[0].symbol, 'BTC')
  eq(new Set(rows.map((r) => r.exchange_id)).size, 10)
})

Deno.test('exchange reserves are bounded to 250 assets per venue, largest by USD value', async () => {
  const writes: Record<string, unknown[]> = {}
  const many = Array.from({ length: 300 }, (_, i) => wallet(`0xw${i}`, `T${i}`, 1000 + i, 1, i + 1))
  const { request } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 1e10)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: () => ({ payload: { data: many }, state: 'fresh', reason: null }),
  })
  const result = await captureExchangeReserves(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.rows, RESERVE_ASSETS_PER_EXCHANGE)
  const rows = writes.intel_exchange_reserve_snapshots as Record<string, unknown>[]
  // The 50 cheapest assets are the ones dropped, never the largest.
  eq(rows[0].usd_value, 300)
  eq(Math.min(...rows.map((r) => Number(r.usd_value))), 51)
  eq((rows[0].raw as Record<string, unknown>).assets, 300)
})

Deno.test('exchange reserves skip inside the cadence and never call the provider', async () => {
  const { request, calls } = fakeRequest({})
  const db = fakeDb({ intel_exchange_reserve_snapshots: [{ created_at: minus(3_600_000) }] })
  const skipped = await captureExchangeReserves(db, ctxFor, NOW, 'startup', { request, policy: [{ feature: 'exchange_reserves', cadence_seconds: 86400 }] })
  eq(skipped.skipped, 'within_cadence'); eq(skipped.credits, 0); eq(skipped.rows, 0); eq(calls.length, 0)
  eq(skipped.newestAt, minus(3_600_000))

  const disabled = await captureExchangeReserves(db, ctxFor, NOW, 'startup', { request, policy: [{ feature: 'exchange_reserves', cadence_seconds: 86400, enabled: false }] })
  eq(disabled.skipped, 'policy_disabled'); eq(calls.length, 0)

  // A shorter cadence in the policy row lets the same run proceed.
  const { request: request2, calls: calls2 } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 1e10)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: () => ({ payload: { data: [wallet('0xa', 'BTC', 1, 1, 60000)] }, state: 'fresh', reason: null }),
  })
  const ran = await captureExchangeReserves(fakeDb({ intel_exchange_reserve_snapshots: [{ created_at: minus(3_600_000) }] }, {}), ctxFor, NOW, 'startup', { request: request2, policy: [{ feature: 'exchange_reserves', cadence_seconds: 900 }] })
  eq(ran.skipped, undefined); eq(ran.rows, 1); eq(calls2.length, 2)
})

Deno.test('exchange reserves report a partial failure, a total failure and a write failure without throwing', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 2e10), exchangeRow(2, 1e10)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: (params: Record<string, unknown>) => Number(params.id) === 2
      ? { payload: null, state: 'error', reason: 'provider_rate_limited' }
      : { payload: { data: [wallet('0xa', 'BTC', 1, 1, 60000)] }, state: 'fresh', reason: null },
  })
  const partial = await captureExchangeReserves(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(partial.rows, 1); eq(partial.credits, 3); eq(partial.exchanges, 1)
  eq(partial.partial, 'provider_rate_limited'); eq(partial.error, undefined)

  const { request: allFail } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 2e10)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: () => ({ payload: null, state: 'error', reason: 'provider_unavailable' }),
  })
  const failedRun = await captureExchangeReserves(fakeDb({}, {}), ctxFor, NOW, 'startup', { request: allFail, policy: [] })
  eq(failedRun.rows, 0); eq(failedRun.error, 'provider_unavailable'); eq(failedRun.credits, 2)

  const { request: noVenues } = fakeRequest({ [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, []), state: 'fresh', reason: null }) })
  const empty = await captureExchangeReserves(fakeDb({}, {}), ctxFor, NOW, 'startup', { request: noVenues, policy: [] })
  eq(empty.rows, 0); eq(empty.credits, 1); assert(String(empty.error).length > 0)

  const { request: ok } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 2e10)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: () => ({ payload: { data: [wallet('0xa', 'BTC', 1, 1, 60000)] }, state: 'fresh', reason: null }),
  })
  const writeFailed = await captureExchangeReserves(fakeDb({}, {}, 'permission denied'), ctxFor, NOW, 'startup', { request: ok, policy: [] })
  eq(writeFailed.error, 'permission denied'); eq(writeFailed.rows, 0)
})

// ─── venue share ──────────────────────────────────────────────────────────────

Deno.test('venue share captures one row per venue per kind per day from a single call', async () => {
  const writes: Record<string, unknown[]> = {}
  const rows = [
    exchangeRow(1, 9e9, { quote: { USD: { volume_24h: 9e9, derivative_volume_24h: 4e9, open_interest: 8e8, last_updated: minus(600_000) } } }),
    exchangeRow(2, 5e9),
  ]
  const { request, calls } = fakeRequest({ [VENUE_CAPABILITY]: () => ({ payload: listPayload(VENUE_CAPABILITY, rows), state: 'fresh', reason: null }) })
  const result = await captureVenueShare(fakeDb({}, writes), ctxFor, NOW, 'startup', { request, policy: [] })
  eq(result.error, undefined); eq(result.credits, 1); eq(calls.length, 1); eq(result.snapshotDate, DAY)
  const written = writes.intel_venue_share_snapshots as Record<string, unknown>[]
  eq(written.length, result.rows)
  for (const row of written) { eq(row.snapshot_date, DAY); assert(['spot', 'derivatives'].includes(String(row.kind))) }
  eq(new Set(written.map((r) => `${r.kind}|${r.exchange_id}`)).size, written.length)
  if (VENUE_CAPABILITY === EXCHANGE_LISTINGS_CAPABILITY) {
    eq(result.spot, 2); eq(result.derivatives, 1); eq(result.partial, undefined)
    const derivative = written.find((r) => r.kind === 'derivatives')!
    eq(derivative.volume_24h, 4e9); eq(derivative.open_interest, 8e8)
  } else {
    // Until `/v1/exchange/listings/latest` is registered the spot half is a
    // reported gap, and the derivatives half comes from the derivatives list.
    eq(result.spot, 0); eq(result.derivatives, 2)
    eq(result.partial, 'spot_listings_capability_unregistered')
    eq(written[0].num_market_pairs, 101)
    eq(written[0].observed_at, minus(600_000))
  }
})

Deno.test('venue share skips inside its cadence, reports an empty page and survives a provider failure', async () => {
  const { request, calls } = fakeRequest({})
  const db = fakeDb({ intel_venue_share_snapshots: [{ created_at: minus(3_600_000) }] })
  const skipped = await captureVenueShare(db, ctxFor, NOW, 'startup', { request, policy: [{ feature: 'venue_share', cadence_seconds: 604800 }] })
  eq(skipped.skipped, 'within_cadence'); eq(skipped.credits, 0); eq(calls.length, 0)

  const { request: emptyPage } = fakeRequest({ [VENUE_CAPABILITY]: () => ({ payload: listPayload(VENUE_CAPABILITY, []), state: 'fresh', reason: null }) })
  const empty = await captureVenueShare(fakeDb({}, {}), ctxFor, NOW, 'startup', { request: emptyPage, policy: [] })
  eq(empty.skipped, 'no_reported_venues'); eq(empty.credits, 1); eq(empty.rows, 0)

  const { request: down } = fakeRequest({ [VENUE_CAPABILITY]: () => ({ payload: null, state: 'error', reason: 'provider_unavailable' }) })
  const failedRun = await captureVenueShare(fakeDb({}, {}), ctxFor, NOW, 'startup', { request: down, policy: [] })
  eq(failedRun.error, 'provider_unavailable'); eq(failedRun.rows, 0); eq(failedRun.credits, 1)

  const { request: ok } = fakeRequest({ [VENUE_CAPABILITY]: () => ({ payload: listPayload(VENUE_CAPABILITY, [exchangeRow(1, 9e9)]), state: 'fresh', reason: null }) })
  const writeFailed = await captureVenueShare(fakeDb({}, {}, 'permission denied'), ctxFor, NOW, 'startup', { request: ok, policy: [] })
  eq(writeFailed.error, 'permission denied'); eq(writeFailed.rows, 0)
})

Deno.test('the ops surface runs both lanes with the signature the Edge Function uses', async () => {
  const writes: Record<string, unknown[]> = {}
  const { request } = fakeRequest({
    [SELECT_CAPABILITY]: () => ({ payload: listPayload(SELECT_CAPABILITY, [exchangeRow(1, 9e9)]), state: 'fresh', reason: null }),
    [ASSETS_CAPABILITY]: () => ({ payload: { data: [wallet('0xa', 'BTC', 1, 2, 60000)] }, state: 'fresh', reason: null }),
    [VENUE_CAPABILITY]: () => ({ payload: listPayload(VENUE_CAPABILITY, [exchangeRow(1, 9e9)]), state: 'fresh', reason: null }),
  })
  const db = fakeDb({}, writes)
  const deps = { request, policy: [] }
  const reserves = await VENUE_CAPTURE_OPS.exchange_reserves(db, ctxFor, NOW, 'startup', deps)
  const share = await VENUE_CAPTURE_OPS.venue_share(db, ctxFor, NOW, 'startup', deps)
  eq(reserves.job, 'exchange_reserves'); eq(reserves.rows, 1); eq(reserves.credits, 2)
  eq(share.job, 'venue_share'); eq(share.credits, 1); assert(share.rows >= 1)
  // The whole lane costs about a dozen credits a day at the documented budget.
  eq(reserves.credits + share.credits <= 12, true)
})
