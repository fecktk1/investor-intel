import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { readRwaYield, yieldHeadline, RWA_YIELD_CAPTURE_VIEWS } from './capture-rwa-yield-read.ts'

const HOUR = '2026-09-16T12:00:00.000Z'
const EARLIER = '2026-09-16T11:00:00.000Z'

const navRow = (over: Record<string, unknown> = {}) => ({
  feed_key: 'ustb', captured_at: HOUR, feed_name: 'USTB NAV per Share',
  contract_address: '0x289b5036cd942e619e1ee48670f98d214e745aac',
  validation_state: 'validated', validation_reason: null, on_chain_description: 'USTB NAV per Share',
  nav: 11.212488, nav_decimals: 6, nav_observed_at: '2026-09-15T18:00:00.000Z', round_id: '1000',
  heartbeat_seconds: 95400, age_seconds: 3600, staleness: 'fresh', rounds_read: 7, por_auditor: 'Superstate',
  source_url: 'https://ethereum-rpc.publicnode.com', fetched_at: HOUR,
  scope: 'Published net asset value per share for the named fund. Not a quote.',
  time_meaning: 'Observation time is the aggregator own updatedAt for that round.',
  ...over,
})
const yieldRow = (over: Record<string, unknown> = {}) => ({
  feed_key: 'ustb', captured_at: HOUR, currency: 'USD', instrument_class: 'treasury_bill',
  realized_state: 'published', realized_annualized_pct: 4.54, realized_window_days: 8.8,
  realized_rounds: 7, realized_declines: 0, realized_largest_decline_pct: null, realized_reason: null,
  first_nav: 11.200497, last_nav: 11.212488, first_at: '2026-09-07T18:00:00.000Z', last_at: '2026-09-15T18:00:00.000Z',
  advertised_pct: null, advertised_observed_at: null, advertised_source_url: null, advertised_reason: 'advertised_not_published',
  benchmark_key: 'us_treasury_bill_3m', benchmark_pct: 4.11, benchmark_observed_at: '2026-09-15',
  benchmark_currency: 'USD', benchmark_reason: null, spread_pct: 0.43,
  fetched_at: HOUR, scope: 'Published net asset value per share.',
  total_return_limit: 'NAV growth is not total return.',
  ...over,
})

/** A catalogue row in the real `market_assets` shape. */
const marketRow = (over: Record<string, unknown> = {}) => ({
  source_provider: 'coingecko', provider_id: 'superstate-short-duration-us-government-securities-fund-ustb',
  name: 'Invesco Short Duration US Government Securities Fund',
  current_price: 11.5, as_of: '2026-09-16T11:30:00.000Z', in_current_catalog: true,
  ...over,
})

/** PostgREST-shaped fake covering select/eq/in/order/limit. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  return {
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, 'eq' | 'in', any][] = []
      const run = (max: number | null) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          rows = rows.filter((row) => op === 'eq'
            ? String(row?.[key] ?? '') === String(operand ?? '')
            // deno-lint-ignore no-explicit-any
            : (operand as any[]).some((v) => String(v) === String(row?.[key] ?? '')))
        }
        rows.sort((a, b) => String(b?.captured_at ?? b?.observed_at ?? '').localeCompare(String(a?.captured_at ?? a?.observed_at ?? '')))
        return { data: max == null ? rows : rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: () => q,
        // deno-lint-ignore no-explicit-any
        eq: (k: string, v: any) => { filters.push([k, 'eq', v]); return q },
        // deno-lint-ignore no-explicit-any
        in: (k: string, v: any[]) => { filters.push([k, 'in', v]); return q },
        order: () => q,
        limit: (max: number) => Promise.resolve(run(max)),
      }
      return q
    },
  }
}

Deno.test('the newest capture hour is rendered and an older hour is not mixed into it', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow(), navRow({ feed_key: 'ustbl', captured_at: EARLIER, feed_name: 'USTBL NAV' })],
    intel_rwa_yield_snapshots: [yieldRow(), yieldRow({ feed_key: 'ustbl', captured_at: EARLIER })],
    intel_benchmark_rates: [{ benchmark_key: 'us_treasury_bill_3m', observed_at: '2026-09-15', rate_pct: 4.11, currency: 'USD', source_url: 'https://home.treasury.gov', time_meaning: 'The Treasury business day.' }],
  }), {}, Date.parse(HOUR))

  eq(result.view, 'rwa_yield')
  eq(result.asOf, HOUR)
  // Two hours side by side would compare figures nobody measured together.
  eq((result.rows as unknown[]).length, 1)
  const row = (result.rows as Record<string, unknown>[])[0]
  eq(row.feedKey, 'ustb')
  eq(row.realizedPct, 4.54)
  eq(row.benchmarkPct, 4.11)
  eq(row.spreadPct, 0.43)
  eq(row.publishable, true)
  eq(row.needsReview, false)
  // The aggregator clock survives into the view.
  eq(row.navObservedAt, '2026-09-15T18:00:00.000Z')
  eq(row.staleness, 'fresh')
  // Provenance is on the row, not only on the payload.
  assert(String(row.scope).length > 20)
  assert(String(row.totalReturnLimit).includes('not total return'))
  eq((result.benchmarks as unknown[]).length, 1)
  eq(result.reason, null)
})

Deno.test('a realized yield of exactly zero is served as zero and never as a blank', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ feed_key: 'vbill', feed_name: 'VBILL NAV', nav: 1 })],
    intel_rwa_yield_snapshots: [yieldRow({ feed_key: 'vbill', realized_annualized_pct: 0, spread_pct: -4.11, first_nav: 1, last_nav: 1 })],
  }), {}, Date.parse(HOUR))
  const row = (result.rows as Record<string, unknown>[])[0]
  eq(row.realizedPct, 0)
  assert(row.realizedPct !== null)
  eq(row.publishable, true)
  eq(row.spreadPct, -4.11)
  eq((result.summary as Record<string, number>).published, 1)
})

Deno.test('a figure that is not publishable is served with its state and no number', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ feed_key: 'crdyx', feed_name: 'CRDYX NAV', nav: 7.6763 })],
    intel_rwa_yield_snapshots: [yieldRow({
      feed_key: 'crdyx', realized_state: 'review_declining', realized_annualized_pct: null,
      realized_reason: 'unexplained_nav_decline', realized_declines: 3, realized_largest_decline_pct: 1.5,
      benchmark_key: null, benchmark_pct: null, benchmark_observed_at: null, benchmark_currency: null,
      benchmark_reason: 'no_free_benchmark_for_private_credit', spread_pct: null,
    })],
  }), {}, Date.parse(HOUR))
  const row = (result.rows as Record<string, unknown>[])[0]
  eq(row.realizedState, 'review_declining')
  eq(row.realizedPct, null)
  eq(row.needsReview, true)
  eq(row.publishable, false)
  eq(row.realizedDeclines, 3)
  eq(row.benchmarkReason, 'no_free_benchmark_for_private_credit')
  eq(row.spreadPct, null)
  eq((result.summary as Record<string, number>).review, 1)
  eq((result.summary as Record<string, number>).published, 0)
})

Deno.test('a refused or stale feed is still a row carrying its reason', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [
      navRow({ feed_key: 'uscc', feed_name: 'USCC NAV per Share', validation_state: 'refused', validation_reason: 'description_mismatch', on_chain_description: 'USCC NAV', nav: null, staleness: 'unknown' }),
      navRow({ feed_key: 'btcy', feed_name: 'BTCY NAV', staleness: 'stale', age_seconds: 561600, heartbeat_seconds: 86400 }),
    ],
    intel_rwa_yield_snapshots: [
      yieldRow({ feed_key: 'uscc', realized_state: 'insufficient_history', realized_annualized_pct: null, realized_reason: 'feed_not_read', benchmark_key: null, benchmark_pct: null, spread_pct: null }),
      yieldRow({ feed_key: 'btcy', realized_state: 'stale_feed', realized_annualized_pct: null, realized_reason: 'feed_stale_against_heartbeat', benchmark_key: null, benchmark_pct: null, spread_pct: null }),
    ],
  }), {}, Date.parse(HOUR))

  eq((result.rows as unknown[]).length, 2)
  const rows = Object.fromEntries((result.rows as Record<string, unknown>[]).map((r) => [r.feedKey, r]))
  eq(rows.uscc.validationState, 'refused')
  eq(rows.uscc.validationReason, 'description_mismatch')
  eq(rows.uscc.onChainDescription, 'USCC NAV')
  eq(rows.uscc.nav, null)
  eq(rows.btcy.staleness, 'stale')
  eq(rows.btcy.realizedState, 'stale_feed')
  const summary = result.summary as Record<string, number>
  eq(summary.refused, 1)
  eq(summary.stale, 1)
  // Unreadable is counted apart from stale: it has not been shown to be healthy.
  eq(summary.unknown, 1)
})

Deno.test('an empty table is an empty list with no as-of rather than a failure', async () => {
  const empty = await readRwaYield(fakeDb({}), {}, Date.parse(HOUR))
  eq(empty.asOf, null)
  eq((empty.rows as unknown[]).length, 0)
  eq(empty.reason, null)
  eq((empty.coverage as Record<string, unknown>).count, 0)

  // A failed read is reported as a reason on an empty result, never a throw.
  const broken = await readRwaYield(fakeDb({}, { intel_rwa_nav_observations: 'permission denied' }), {}, Date.parse(HOUR))
  eq(broken.reason, 'permission denied')
  eq(broken.asOf, null)
})

Deno.test('a name-verified catalogue row prices the market against the published nav', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ nav: 11.5 })],
    intel_rwa_yield_snapshots: [yieldRow()],
    market_assets: [marketRow({ current_price: 11.615 })],
  }), {}, Date.parse(HOUR))
  const row = (result.rows as Record<string, unknown>[])[0]
  eq(row.marketProvider, 'coingecko')
  eq(row.marketProviderId, 'superstate-short-duration-us-government-securities-fund-ustb')
  eq(row.marketNameSeen, 'Invesco Short Duration US Government Securities Fund')
  eq(row.deviationReason, null)
  eq(Number(Number(row.deviationPct).toFixed(4)), 1)
  // The catalogue's own clock, never our read time.
  eq(row.marketObservedAt, '2026-09-16T11:30:00.000Z')
  eq((result.summary as Record<string, number>).priced, 1)
  // The source mix is stated on the payload, not left for the reader to infer.
  assert(String(result.marketSourceNote).includes('never on a ticker'))
  assert(String(result.marketSourceLimit).includes('no identifier'))
})

Deno.test('a drifted catalogue name and a fund with no safe identity are both refused', async () => {
  // The rename guard. The id still resolves, but the row is no longer this fund.
  const drifted = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ nav: 11.5 })],
    intel_rwa_yield_snapshots: [yieldRow()],
    market_assets: [marketRow({ name: 'Something Else Entirely' })],
  }), {}, Date.parse(HOUR))
  const row = (drifted.rows as Record<string, unknown>[])[0]
  eq(row.deviationPct, null)
  eq(row.deviationReason, 'market_name_mismatch')
  eq(row.marketNameSeen, 'Something Else Entirely')
  eq((drifted.summary as Record<string, number>).priced, 0)

  // A registered id with no catalogue row is its own reason.
  const absent = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ nav: 11.5 })],
    intel_rwa_yield_snapshots: [yieldRow()],
    market_assets: [],
  }), {}, Date.parse(HOUR))
  eq((absent.rows as Record<string, unknown>[])[0].deviationReason, 'market_not_in_catalogue')

  // `M` has no safe identity in our catalogue, so it is never priced even when a
  // same-ticker row exists. This is the MemeCore trap, refused.
  const mzero = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ feed_key: 'mzero', feed_name: 'M NAV', nav: 1.024 })],
    intel_rwa_yield_snapshots: [yieldRow({ feed_key: 'mzero' })],
    market_assets: [marketRow({ provider_id: 'memecore', name: 'MemeCore', current_price: 0.91 })],
  }), {}, Date.parse(HOUR))
  const m = (mzero.rows as Record<string, unknown>[])[0]
  eq(m.deviationPct, null)
  eq(m.deviationReason, 'market_price_not_mapped')
  eq(m.marketProviderId, null)
})

Deno.test('a euro fund keeps its market identity and still refuses a dollar quote', async () => {
  const result = await readRwaYield(fakeDb({
    intel_rwa_nav_observations: [navRow({ feed_key: 'eutbl', feed_name: 'EUTBL NAV', nav: 1.058897 })],
    intel_rwa_yield_snapshots: [yieldRow({ feed_key: 'eutbl', currency: 'EUR', benchmark_key: 'estr', benchmark_pct: 2.19, benchmark_currency: 'EUR' })],
    market_assets: [marketRow({ provider_id: 'eutbl', name: 'Spiko EU T-Bills Money Market Fund', current_price: 1.24 })],
  }), {}, Date.parse(HOUR))
  const row = (result.rows as Record<string, unknown>[])[0]
  // The identity resolved and the name matched, so the ONLY thing stopping the
  // figure is the currency. Converting would bury an exchange rate in a premium.
  eq(row.marketProviderId, 'eutbl')
  eq(row.marketNameSeen, 'Spiko EU T-Bills Money Market Fund')
  eq(row.deviationPct, null)
  eq(row.deviationReason, 'currency_mismatch_price_vs_nav')
})

Deno.test('the headline never promotes a number that its state does not support', () => {
  eq(yieldHeadline({ realized_state: 'published', realized_annualized_pct: 0, benchmark_pct: 4.11, spread_pct: -4.11 }).realizedPct, 0)
  eq(yieldHeadline({ realized_state: 'review_declining', realized_annualized_pct: -53.7 }).realizedPct, null)
  eq(yieldHeadline({ realized_state: 'review_implausible', realized_annualized_pct: 92.3 }).needsReview, true)
  eq(yieldHeadline({ realized_state: 'stale_feed' }).publishable, false)
  eq(yieldHeadline({}).state, 'insufficient_history')
  // The view is reachable through the shared surface.
  assert(typeof RWA_YIELD_CAPTURE_VIEWS.rwa_yield === 'function')
})
