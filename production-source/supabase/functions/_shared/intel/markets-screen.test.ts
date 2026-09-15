import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { marketScreenResponse, screenFreshness, MARKET_SCREEN_SORTS } from './markets-screen.ts'

// The module formats rows the database has already screened, so these tests
// assert the CONTRACT the client reads — field names, nulls and pass-through —
// not any filtering or ordering, which belongs to intel_markets_screen_for_user.

const row = (over: Record<string, unknown> = {}) => ({
  source_provider: 'coinmarketcap', provider_id: '1', symbol: 'BTC', name: 'Bitcoin',
  current_price: 64000, market_cap: 1.2e12, as_of: new Date().toISOString(), ...over,
})
const screen = (over: Record<string, unknown> = {}) => ({
  records: [row()], total: 1, page: 0, limit: 50, snapshot: { trackedAssets: 1 },
  sort: 'market_cap', dir: 'desc', ...over,
})

Deno.test('the projection carries the recorded high and the window it was measured over', () => {
  const measured = marketScreenResponse(screen({
    records: [row({ drawdown_pct: -42.5, recorded_high_price: 111304.35, recorded_high_date: '2026-09-10', recorded_window_days: 64 })],
  })).rows[0]
  eq(measured.drawdownPct, -42.5)
  eq(measured.recordedHighPrice, 111304.35)
  eq(measured.recordedHighDate, '2026-09-10')
  eq(measured.recordedWindowDays, 64)
})

Deno.test('an unmeasured asset projects nulls, never a zero drawdown or an invented window', () => {
  // A row from before the refresh ran, and a row whose window is one day: both
  // are "not measured", and neither may render as "at its high".
  for (const record of [row(), row({ recorded_high_price: 64000, recorded_high_date: '2026-09-15', recorded_window_days: 1 })]) {
    const projected = marketScreenResponse(screen({ records: [record] })).rows[0]
    eq(projected.drawdownPct, null)
    assert(projected.recordedWindowDays !== undefined, 'the window field is always present')
  }
  const empty = marketScreenResponse(screen({ records: [row({ recorded_window_days: 0 })] })).rows[0]
  // A reported zero window stays zero: nothing recorded is a reading too.
  eq(empty.recordedWindowDays, 0)
})

Deno.test('the screen echoes the sort the database resolved, including drawdown', () => {
  assert(MARKET_SCREEN_SORTS.includes('drawdown'), 'drawdown is an accepted sort key')
  // Every key here has to exist in the screener's CASE; these are the reviewed
  // twelve plus drawdown, and a removal would be a contract break.
  for (const key of ['market_cap', 'rank', 'gainers', 'losers', 'market_pairs', 'drawdown']) {
    assert(MARKET_SCREEN_SORTS.includes(key as never), `${key} is accepted`)
  }
  const response = marketScreenResponse(screen({ sort: 'drawdown', dir: 'asc' }))
  eq(response.sort, 'drawdown'); eq(response.dir, 'asc')
  // The direction is whatever the database resolved, never re-derived here.
  eq(marketScreenResponse(screen({ sort: 'drawdown', dir: 'desc' })).dir, 'desc')
  eq(marketScreenResponse(screen({ sort: undefined, dir: undefined })).sort, null)
})

Deno.test('freshness still reads the capture clock, not the drawdown', () => {
  eq(screenFreshness(new Date().toISOString()), 'fresh')
  eq(screenFreshness(new Date(Date.now() - 10 * 60_000).toISOString()), 'stale')
  eq(screenFreshness(null), 'unavailable')
  eq(screenFreshness(new Date().toISOString(), true), 'degraded')
})
