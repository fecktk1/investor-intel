import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { ASSET_TABLE, TOKEN_TABLE } from './capture-rwa-wrappers.ts'
import {
  CATALOGUE_TABLE, readRwaWrappers, readRwaWrapperPicks, marketCoverage,
  RWA_WRAPPER_CAPTURE_VIEWS, RWA_WRAPPER_VIEWS,
} from './capture-rwa-wrappers-read.ts'

const NOW = new Date(Math.floor((Date.now() - 7 * 86_400_000) / 3_600_000) * 3_600_000)
const HOUR = NOW.toISOString()

/** PostgREST-shaped fake: eq/in filters, order, limit. Records the columns each
 * select asked for, so the widened catalogue read is checked rather than assumed. */
// deno-lint-ignore no-explicit-any
function fakeDb(tables: Record<string, any[]> = {}, errors: Record<string, string> = {}) {
  const selects: Record<string, string> = {}
  return {
    selects,
    from(table: string) {
      // deno-lint-ignore no-explicit-any
      const filters: [string, string, any][] = []
      const run = (max: number) => {
        if (errors[table]) return { data: null, error: { message: errors[table] } }
        let rows = [...(tables[table] || [])]
        for (const [key, op, operand] of filters) {
          // deno-lint-ignore no-explicit-any
          rows = rows.filter((row) => (op === 'eq' ? String(row?.[key] ?? '') === String(operand) : (operand as any[]).some((o) => String(o) === String(row?.[key]))))
        }
        return { data: rows.slice(0, max), error: null }
      }
      // deno-lint-ignore no-explicit-any
      const q: any = {
        select: (columns: string) => { selects[table] = columns; return q },
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

const ANCHOR = 4369.87655050591
const tables = () => ({
  [ASSET_TABLE]: [
    { provider: 'coinmarketcap', rwa_id: '1', captured_at: HOUR, symbol: 'GOLD', name: 'Gold', asset_type: 'commodity', wrapper_count: 5, anchor_kind: 'liquid_wrapper_median', anchor_price: ANCHOR, anchor_reason: 'no_nav_feed_mapped', dispersion_bps: 75.7, cheapest_crypto_id: '20245', cheapest_premium_bps: -75.7 },
    { provider: 'coinmarketcap', rwa_id: '5', captured_at: HOUR, symbol: 'SILVER', name: 'Silver', asset_type: 'commodity', wrapper_count: 2, anchor_kind: 'none', anchor_reason: 'not_enough_liquid_wrappers' },
  ],
  [TOKEN_TABLE]: [
    { rwa_id: '1', crypto_id: '5176', captured_at: HOUR, symbol: 'XAUT', price: ANCHOR, normalised_price: ANCHOR, premium_bps: 0, volume_24h: 70850040, wrapper_state: 'liquid', unit_state: 'consistent', in_anchor: true },
    { rwa_id: '1', crypto_id: '4705', captured_at: HOUR, symbol: 'PAXG', price: 4372.1, normalised_price: 4372.1, premium_bps: 5.1, volume_24h: 60100000, wrapper_state: 'liquid', unit_state: 'consistent', in_anchor: true },
    { rwa_id: '1', crypto_id: '20245', captured_at: HOUR, symbol: 'CGO', price: 139.43, normalised_price: 4336.79, premium_bps: -75.7, volume_24h: 922206, wrapper_state: 'liquid', unit_state: 'normalised_troy_ounce', in_anchor: true },
    { rwa_id: '1', crypto_id: '28030', captured_at: HOUR, symbol: 'VNXAU', price: 4352.11, normalised_price: 4352.11, premium_bps: -40.7, volume_24h: 0, wrapper_state: 'too_thin_to_anchor', unit_state: 'consistent', state_reason: 'below_volume_floor' },
    { rwa_id: '1', crypto_id: '31411', captured_at: HOUR, symbol: 'XAUTT', wrapper_state: 'no_price', unit_state: 'not_assessed', state_reason: 'price_not_reported' },
    { rwa_id: '5', crypto_id: '80001', captured_at: HOUR, symbol: 'SLVA', price: 53, volume_24h: 600000, wrapper_state: 'liquid', unit_state: 'consistent' },
  ],
  [CATALOGUE_TABLE]: [
    { source_provider: 'coinmarketcap', provider_id: '5176', num_market_pairs: 212, in_current_catalog: true },
    { source_provider: 'coinmarketcap', provider_id: '4705', num_market_pairs: null, in_current_catalog: true },
    // Dropped from the catalogue's current refresh: priced and traded per the
    // provider, but no market count of ours confirms it.
    { source_provider: 'coinmarketcap', provider_id: '20245', num_market_pairs: 4, in_current_catalog: false },
    { source_provider: 'coinmarketcap', provider_id: '80001', num_market_pairs: 0, in_current_catalog: true },
  ],
})

Deno.test('market coverage is four states with a reason, and a failed read assesses nothing', () => {
  const market = { marketPairs: 3, inCurrentCatalog: true }
  eq(marketCoverage({ price: null, volume24h: null }, market, true), { state: 'listed_only', reason: 'price_not_reported' })
  eq(marketCoverage({ price: 1, volume24h: null }, market, true), { state: 'priced_not_traded', reason: 'volume_not_reported' })
  eq(marketCoverage({ price: 1, volume24h: 0 }, market, true), { state: 'priced_not_traded', reason: 'volume_reported_zero' })
  eq(marketCoverage({ price: 1, volume24h: 9 }, null, true), { state: 'no_tracked_market', reason: 'not_in_catalogue' })
  eq(marketCoverage({ price: 1, volume24h: 9 }, { marketPairs: 3, inCurrentCatalog: false }, true), { state: 'no_tracked_market', reason: 'not_in_current_catalogue' })
  eq(marketCoverage({ price: 1, volume24h: 9 }, { marketPairs: 0, inCurrentCatalog: true }, true), { state: 'priced_not_traded', reason: 'no_market_pairs' })
  eq(marketCoverage({ price: 1, volume24h: 9 }, market, true), { state: 'tradeable', reason: null })
  // A pair count the catalogue did not report is said, never read as zero.
  eq(marketCoverage({ price: 1, volume24h: 9 }, { marketPairs: null, inCurrentCatalog: true }, true), { state: 'tradeable', reason: 'pair_count_not_reported' })
  eq(marketCoverage({ price: 1, volume24h: 9 }, null, false), { state: null, reason: 'catalogue_unavailable' })
})

Deno.test('the board reads pair counts in the same catalogue query and labels every wrapper', async () => {
  const db = fakeDb(tables())
  const view = await readRwaWrappers(db, {}, NOW.getTime())
  assert(db.selects[CATALOGUE_TABLE].includes('num_market_pairs'))
  assert(db.selects[CATALOGUE_TABLE].includes('in_current_catalog'))
  // deno-lint-ignore no-explicit-any
  const gold = (view.rows as any[]).find((row) => row.rwaId === '1')
  // deno-lint-ignore no-explicit-any
  const byId = new Map<string, any>(gold.tokens.map((t: any) => [t.cryptoId, t]))
  eq(byId.get('5176').coverageState, 'tradeable')
  eq(byId.get('5176').marketPairs, 212)
  eq(byId.get('4705').coverageReason, 'pair_count_not_reported')
  eq(byId.get('20245').coverageState, 'no_tracked_market')
  eq(byId.get('28030').coverageState, 'priced_not_traded')
  eq(byId.get('31411').coverageState, 'listed_only')
  // deno-lint-ignore no-explicit-any
  const silver = (view.rows as any[]).find((row) => row.rwaId === '5')
  eq(silver.tokens[0].coverageReason, 'no_market_pairs')
  eq(view.marketCoverageReason, null)
})

Deno.test('a failed catalogue read leaves coverage unassessed, says so once, and keeps the board', async () => {
  const view = await readRwaWrappers(fakeDb(tables(), { [CATALOGUE_TABLE]: 'permission denied' }), {}, NOW.getTime())
  eq(view.reason, null)
  eq(view.marketCoverageReason, 'permission denied')
  // deno-lint-ignore no-explicit-any
  const gold = (view.rows as any[]).find((row) => row.rwaId === '1')
  // deno-lint-ignore no-explicit-any
  const xaut = gold.tokens.find((t: any) => t.cryptoId === '5176')
  eq(xaut.coverageState, null)
  eq(xaut.coverageReason, 'catalogue_unavailable')
  // The unpriced wrapper needs no catalogue to be listed-only.
  // deno-lint-ignore no-explicit-any
  eq(gold.tokens.find((t: any) => t.cryptoId === '31411').coverageState, 'listed_only')
})

Deno.test('every board row carries its picks, agreeing with the stored cheapest route', async () => {
  const view = await readRwaWrappers(fakeDb(tables()), {}, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  const gold = (view.rows as any[]).find((row) => row.rwaId === '1')
  eq(gold.picks.cheapest.cryptoId, gold.cheapestCryptoId)
  eq(gold.picks.cheapestMatchesCaptured, true)
  eq(gold.picks.closest.cryptoId, '5176')
  eq(gold.picks.closest.circular, true)
  eq(gold.picks.closest.closestOther.cryptoId, '4705')
  eq(gold.picks.mostLiquid.cryptoId, '5176')
  // deno-lint-ignore no-explicit-any
  eq(gold.picks.excluded.map((row: any) => row.cryptoId), ['31411'])
  // deno-lint-ignore no-explicit-any
  const silver = (view.rows as any[]).find((row) => row.rwaId === '5')
  eq(silver.picks.cheapest, { available: false, reason: 'not_enough_liquid_wrappers' })
  assert(view.pickRules)
})

Deno.test('the picks view answers by rwa id or by any wrapper id, and says why when it cannot', async () => {
  const byAsset = await readRwaWrapperPicks(fakeDb(tables()), { rwaId: '1' }, NOW.getTime())
  eq(byAsset.view, 'rwa_wrapper_picks')
  eq(byAsset.state, 'ready')
  eq(byAsset.asOf, HOUR)
  // deno-lint-ignore no-explicit-any
  eq((byAsset.asset as any).symbol, 'GOLD')
  // deno-lint-ignore no-explicit-any
  eq((byAsset.picks as any).cheapest.cryptoId, '20245')

  const byWrapper = await readRwaWrapperPicks(fakeDb(tables()), { cryptoId: '20245' }, NOW.getTime())
  // deno-lint-ignore no-explicit-any
  eq((byWrapper.asset as any).rwaId, '1')

  const missing = await readRwaWrapperPicks(fakeDb(tables()), { rwaId: '999' }, NOW.getTime())
  eq(missing.state, 'not_in_capture')
  eq(missing.picks, null)
  eq(missing.asOf, HOUR)

  const empty = await readRwaWrapperPicks(fakeDb(), { rwaId: '1' }, NOW.getTime())
  eq(empty.state, 'not_captured')
  eq(empty.asOf, null)

  const none = await readRwaWrapperPicks(fakeDb(tables()), {}, NOW.getTime())
  eq(none.reason, 'no_asset_selected')
  // A malformed id is treated as no id, never interpolated into a filter.
  eq((await readRwaWrapperPicks(fakeDb(tables()), { rwaId: '1 or 1=1' }, NOW.getTime())).reason, 'no_asset_selected')
})

Deno.test('the picks view is registered for the capture read path under both argument spellings', async () => {
  eq([...RWA_WRAPPER_VIEWS], ['rwa_wrappers', 'rwa_wrapper_picks'])
  eq(Object.keys(RWA_WRAPPER_CAPTURE_VIEWS), ['rwa_wrappers', 'rwa_wrapper_picks'])
  const camel = await RWA_WRAPPER_CAPTURE_VIEWS.rwa_wrapper_picks(fakeDb(tables()), { rwaId: '1' }, NOW.getTime())
  const snake = await RWA_WRAPPER_CAPTURE_VIEWS.rwa_wrapper_picks(fakeDb(tables()), { rwa_id: '1' }, NOW.getTime())
  eq(camel.state, 'ready')
  eq(snake.state, 'ready')
})
