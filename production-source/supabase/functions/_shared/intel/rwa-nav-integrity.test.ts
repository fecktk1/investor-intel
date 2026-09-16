import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { navPriceDeviation, navIntegrityRow, navIntegrityBoard, marketDeviation, QUOTE_MAX_AGE_SECONDS } from './rwa-nav-integrity.ts'
import { RWA_FEED_BY_KEY } from './rwa-yield-register.ts'

const NOW = Date.parse('2026-09-16T12:00:00Z')
/** A catalogue quote carrying the name the register expects, so the name gate
 * passes and the arithmetic is what is under test. */
const quoteFor = (key: string, priceUsd: number) =>
  ({ priceUsd, observedAt: '2026-09-16T11:00:00Z', name: RWA_FEED_BY_KEY[key].marketName, provider: 'coingecko', providerId: RWA_FEED_BY_KEY[key].marketProviderId })
const fresh = (priceUsd: number) => ({ priceUsd, observedAt: '2026-09-16T11:00:00Z' })
/** USTB has a registered, name-verified market identity. */
const mapped = RWA_FEED_BY_KEY.ustb

Deno.test('a market price above or below the published nav is reported as a signed gap', () => {
  const premium = navPriceDeviation(100, fresh(102), { now: NOW })
  eq(premium.reason, null)
  eq(Number(premium.deviationPct?.toFixed(6)), 2)

  const discount = navPriceDeviation(100, fresh(95), { now: NOW })
  eq(Number(discount.deviationPct?.toFixed(6)), -5)

  // Exact agreement is a real measurement and is returned as zero, not as absent.
  const agreed = navPriceDeviation(11.212488, fresh(11.212488), { now: NOW })
  eq(agreed.deviationPct, 0)
  eq(agreed.reason, null)
})

Deno.test('a euro nav is never compared against a dollar quote', () => {
  // Subtracting a USD price from a EUR nav would bury an exchange rate inside
  // something displayed as a premium or discount.
  const eur = navPriceDeviation(1.058897, fresh(1.10), { currency: 'EUR', now: NOW })
  eq(eur.deviationPct, null)
  eq(eur.reason, 'currency_mismatch_price_vs_nav')

  // EUTBL has a registered market identity and a name-matching quote, so the
  // ONLY thing stopping the figure is the currency. The catalogue prices in USD
  // and the fund reports in euros.
  const eutbl = navIntegrityRow(
    RWA_FEED_BY_KEY.eutbl,
    { nav: 1.058897, updatedAt: Math.floor(NOW / 1000) - 3600, heartbeatSeconds: 97200 },
    quoteFor('eutbl', 1.10),
    NOW,
  )
  eq(eutbl.currency, 'EUR')
  eq(eutbl.deviationPct, null)
  eq(eutbl.deviationReason, 'currency_mismatch_price_vs_nav')
  // The staleness half of the monitor still works for a euro feed.
  eq(eutbl.staleness, 'fresh')
})

Deno.test('a fund with no safe catalogue identity is never priced from a ticker', () => {
  // The live trap: `M` is MemeCore and Mantis in our own catalogue. The register
  // records no id, so even with a perfectly good quote in hand there is no join.
  const mzero = navIntegrityRow(
    RWA_FEED_BY_KEY.mzero,
    { nav: 1.024, updatedAt: Math.floor(NOW / 1000), heartbeatSeconds: 86400 },
    { priceUsd: 0.91, observedAt: '2026-09-16T11:00:00Z', name: 'MemeCore', provider: 'coingecko', providerId: 'memecore' },
    NOW,
  )
  eq(mzero.deviationPct, null)
  eq(mzero.deviationReason, 'market_price_not_mapped')
  eq(mzero.marketProviderId, null)
  // USTBL is ambiguous in the catalogue and is treated the same way.
  eq(marketDeviation(RWA_FEED_BY_KEY.ustbl, 1.09, quoteFor('ustb', 1.1), NOW).reason, 'market_price_not_mapped')
})

Deno.test('a catalogue row whose fund name has drifted is refused rather than priced', () => {
  // The id is stable, the name is not. USTB already proves this: its id still
  // names Superstate while the catalogue name is now Invesco. If the name moves
  // again, the comparison must stop rather than price a renamed row.
  const drifted = navIntegrityRow(
    RWA_FEED_BY_KEY.ustb,
    { nav: 11.2, updatedAt: Math.floor(NOW / 1000), heartbeatSeconds: 95400 },
    { priceUsd: 11.5, observedAt: '2026-09-16T11:00:00Z', name: 'Something Else Entirely', provider: 'coingecko', providerId: RWA_FEED_BY_KEY.ustb.marketProviderId },
    NOW,
  )
  eq(drifted.deviationPct, null)
  eq(drifted.deviationReason, 'market_name_mismatch')
  // The drift itself is retained so a reviewer can see what the row became.
  eq(drifted.marketNameSeen, 'Something Else Entirely')

  // The registered name matching is what lets the figure through.
  const matched = navIntegrityRow(
    RWA_FEED_BY_KEY.ustb,
    { nav: 11.2, updatedAt: Math.floor(NOW / 1000), heartbeatSeconds: 95400 },
    quoteFor('ustb', 11.5), NOW,
  )
  eq(matched.deviationReason, null)
  assert(matched.deviationPct !== null)
  eq(matched.marketProvider, 'coingecko')

  // A registered id with no row in the catalogue is its own distinct reason.
  eq(marketDeviation(RWA_FEED_BY_KEY.ustb, 11.2, null, NOW).reason, 'market_not_in_catalogue')
  // A row with no name at all cannot be verified, so it is not used.
  eq(marketDeviation(RWA_FEED_BY_KEY.ustb, 11.2, fresh(11.5), NOW).reason, 'market_name_mismatch')
})

Deno.test('an undated, stale or missing quote yields no number and a stated reason', () => {

  eq(navPriceDeviation(100, { priceUsd: 102, observedAt: null }, { now: NOW }).reason, 'quote_undated')
  eq(navPriceDeviation(100, { priceUsd: 102, observedAt: '2026-09-14T11:00:00Z' }, { now: NOW }).reason, 'quote_stale')
  eq(navPriceDeviation(100, null, { now: NOW }).reason, 'no_market_price')
  eq(navPriceDeviation(100, { priceUsd: 0, observedAt: '2026-09-16T11:00:00Z' }, { now: NOW }).reason, 'no_market_price')
  eq(navPriceDeviation(0, fresh(102), { now: NOW }).reason, 'no_nav')
  eq(navPriceDeviation(null, fresh(102), { now: NOW }).reason, 'no_nav')
  assert(QUOTE_MAX_AGE_SECONDS >= 3600)
})

Deno.test('a feed past its own heartbeat is reported stale and one with no clock is not called fresh', () => {
  // The real 2026-09-16 case: 156 hours old against a 24 hour heartbeat.
  const stale = navIntegrityRow(
    RWA_FEED_BY_KEY.btcy,
    { nav: 1.0025201896719111, updatedAt: Math.floor(NOW / 1000) - 156 * 3600, heartbeatSeconds: 86400 },
    null, NOW,
  )
  eq(stale.staleness, 'stale')
  eq(stale.stalenessReason, null)
  assert((stale.ageSeconds ?? 0) > 86400)
  // The row still carries what we did read, so it is never an empty line.
  eq(stale.latestNav, 1.0025201896719111)
  assert(stale.observedAt !== null)
  assert(stale.navScope.length > 40)

  const ok = navIntegrityRow(RWA_FEED_BY_KEY.ustbl, { nav: 1.096072, updatedAt: Math.floor(NOW / 1000) - 1800, heartbeatSeconds: 97200 }, null, NOW)
  eq(ok.staleness, 'fresh')

  // A feed we could not read at all is unknown, which is not the same as fine.
  const unreadable = navIntegrityRow(RWA_FEED_BY_KEY.jaaa, { nav: null, updatedAt: null, heartbeatSeconds: 97200 }, null, NOW)
  eq(unreadable.staleness, 'unknown')
  eq(unreadable.stalenessReason, 'no_round_clock')
  eq(unreadable.latestNav, null)

  // A feed publishing no heartbeat is not judged stale by an invented bound.
  const noHeartbeat = navIntegrityRow(RWA_FEED_BY_KEY.jtrsy, { nav: 1.116084, updatedAt: Math.floor(NOW / 1000) - 400 * 3600, heartbeatSeconds: null }, null, NOW)
  eq(noHeartbeat.staleness, 'unknown')
  eq(noHeartbeat.stalenessReason, 'no_published_heartbeat')
})

Deno.test('the board counts stale and unreadable separately and keeps the worst gap', () => {
  const at = Math.floor(NOW / 1000)
  const rows = [
    navIntegrityRow(mapped, { nav: 100, updatedAt: at - 60, heartbeatSeconds: 95400 }, quoteFor('ustb', 103), NOW),
    navIntegrityRow(RWA_FEED_BY_KEY.vbill, { nav: 100, updatedAt: at - 60, heartbeatSeconds: 97200 }, quoteFor('vbill', 99), NOW),
    navIntegrityRow(RWA_FEED_BY_KEY.btcy, { nav: 1, updatedAt: at - 156 * 3600, heartbeatSeconds: 86400 }, null, NOW),
    navIntegrityRow(RWA_FEED_BY_KEY.jaaa, { nav: null, updatedAt: null, heartbeatSeconds: 97200 }, null, NOW),
  ]
  const board = navIntegrityBoard(rows)
  eq(board.monitored, 4)
  eq(board.stale, 1)
  // Unreadable is counted on its own and never folded into fresh.
  eq(board.unknown, 1)
  eq(board.priced, 2)
  // Worst is by magnitude, so a three percent premium beats a one percent discount.
  eq(Number(board.worstDeviationPct?.toFixed(6)), 3)
  // A failure never shortens the list: every monitored feed is still a row.
  eq(board.rows.length, 4)
  eq(navIntegrityBoard([]).monitored, 0)
  eq(navIntegrityBoard([]).worstDeviationPct, null)
})
