// Investor Intel: NAV Integrity Monitor.
//
// Two questions about a NAV feed that have nothing to do with yield:
//
//   1. IS IT STILL UPDATING? Every feed publishes its own heartbeat, which is
//      the only defensible staleness bound we have. Probed 2026-09-16, the BTCY
//      feed's newest round was 156 hours old against a 24 hour heartbeat, so
//      this catches real problems and not hypothetical ones.
//
//   2. DOES THE MARKET AGREE WITH IT? A token can trade away from the net asset
//      value its own issuer publishes. The deviation is the gap between the two.
//
// THE TWO HALVES ARE ALWAYS TWO SOURCES. A net asset value is struck by the
// fund and published to its own Chainlink feed; a market price is observed on
// venues and reaches us through our CoinGecko-sourced catalogue. They can never
// share a source, so what matters is that the join is right and that the mix is
// stated on the surface beside the figure.
//
// WHAT THIS MODULE REFUSES TO DO. It will not compare a market price to a NAV
// denominated in a different currency. Catalogue prices are USD; a euro fund's
// NAV is euros; subtracting one from the other would bury an exchange rate
// inside something displayed as a premium or discount. That case reports
// `currency_mismatch_price_vs_nav` and shows no number.
//
// It also will not invent the join, and the reason is not hypothetical. Checked
// against our own `market_assets` on 2026-09-16, the ticker `M` resolves to
// MemeCore and to Mantis, neither of which is the M-zero protocol whose NAV feed
// we read, and `USTBL` collides with two rows. A ticker join would have priced
// one fund's net asset value against another asset's quote. So the market side
// is matched on the catalogue's own provider id, with the fund NAME re-verified
// here at read time: a feed with no registered id reports
// `market_price_not_mapped`, a catalogue with no such row reports
// `market_not_in_catalogue`, and a row whose name has drifted reports
// `market_name_mismatch` instead of being priced.

import { navIsStale } from './rwa-yield-realized.ts'
import type { RwaYieldFeed } from './rwa-yield-register.ts'

/** How old a retained quote may be before it stops describing "now". Matches the
 * 24 hour window `cached-asset-quote.ts` already reads over. */
export const QUOTE_MAX_AGE_SECONDS = 86400

export const DEVIATION_SCOPE =
  'The gap between a reported market price and the fund\'s own published net asset value. It is not a tradable spread, not an arbitrage, and not a statement that either figure is wrong.'

export type StalenessState = 'fresh' | 'stale' | 'unknown'

export interface NavQuote {
  /** USD, as the catalogue row states it. */
  priceUsd: number | null
  /** The catalogue's own `as_of` for the quote, never our read time. */
  observedAt: string | null
  /** The fund name the catalogue currently carries, compared against the
   * register's recorded name before the quote may be used. */
  name?: string | null
  /** Which catalogue this came from, carried onto the row so the surface can
   * state that the market half is a different source from the NAV half. */
  provider?: string | null
  providerId?: string | null
}

export interface NavDeviation {
  deviationPct: number | null
  reason: string | null
}

const finite = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Market price against NAV, as a percent of NAV.
 *
 * Positive means the market pays MORE than the published NAV. A deviation of
 * exactly 0 is a real measurement that the two agreed, and is returned as 0. */
export function navPriceDeviation(
  nav: unknown,
  quote: NavQuote | null,
  options: { currency?: string; now?: number; maxAgeSeconds?: number } = {},
): NavDeviation {
  const currency = options.currency || 'USD'
  // The currency gate comes first: there is no point aging a quote we are never
  // allowed to subtract.
  if (currency !== 'USD') return { deviationPct: null, reason: 'currency_mismatch_price_vs_nav' }
  const navValue = finite(nav)
  if (navValue == null || navValue <= 0) return { deviationPct: null, reason: 'no_nav' }
  const price = finite(quote?.priceUsd)
  if (price == null || price <= 0) return { deviationPct: null, reason: 'no_market_price' }
  const observed = quote?.observedAt ? Date.parse(quote.observedAt) : NaN
  if (!Number.isFinite(observed)) return { deviationPct: null, reason: 'quote_undated' }
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeSeconds ?? QUOTE_MAX_AGE_SECONDS
  if ((now - observed) / 1000 > maxAge) return { deviationPct: null, reason: 'quote_stale' }
  const deviationPct = ((price - navValue) / navValue) * 100
  if (!Number.isFinite(deviationPct)) return { deviationPct: null, reason: 'not_computable' }
  return { deviationPct, reason: null }
}

/** The market side, gated in the order that fails cheapest first.
 *
 * No registered id is not the same as a catalogue that holds no such row, and
 * neither is the same as a row whose name no longer matches the fund we
 * recorded. Each gets its own reason so the surface can say which happened. */
export function marketDeviation(
  feed: Pick<RwaYieldFeed, 'currency' | 'marketProviderId' | 'marketName'>,
  nav: unknown,
  quote: NavQuote | null,
  now: number,
): NavDeviation {
  if (!feed.marketProviderId) return { deviationPct: null, reason: 'market_price_not_mapped' }
  if (!quote) return { deviationPct: null, reason: 'market_not_in_catalogue' }
  // THE NAME GATE. The id is stable, the name is not: a fund can be renamed or a
  // row repurposed, and pricing whatever the row has become would be exactly the
  // wrong-entity failure the id join was chosen to avoid.
  const seen = String(quote.name ?? '').trim()
  const expected = String(feed.marketName ?? '').trim()
  if (!expected || !seen || seen !== expected) return { deviationPct: null, reason: 'market_name_mismatch' }
  return navPriceDeviation(nav, quote, { currency: feed.currency, now })
}

export interface NavIntegrityRow {
  key: string
  feedName: string
  address: string
  currency: string
  latestNav: number | null
  /** The aggregator's own round clock, never our capture time. */
  observedAt: string | null
  heartbeatSeconds: number | null
  ageSeconds: number | null
  staleness: StalenessState
  stalenessReason: string | null
  marketPriceUsd: number | null
  priceObservedAt: string | null
  deviationPct: number | null
  deviationReason: string | null
  /** Where the market half came from, stated beside the figure because the two
   * halves of a deviation are always two different sources. */
  marketProvider: string | null
  marketProviderId: string | null
  /** What the catalogue called the fund when we read it, kept even on a name
   * mismatch so the drift itself is reviewable. */
  marketNameSeen: string | null
  navScope: string
}

/** One monitored feed.
 *
 * A feed we could not read is still a ROW, carrying the reason it could not be
 * read. A failure never shortens this list: an absent feed would read as a feed
 * with nothing wrong with it. */
export function navIntegrityRow(
  feed: Pick<RwaYieldFeed, 'key' | 'feedName' | 'address' | 'currency' | 'navScope' | 'marketProvider' | 'marketProviderId' | 'marketName'>,
  latest: { nav: number | null; updatedAt: number | null; heartbeatSeconds: number | null } | null,
  quote: NavQuote | null,
  now: number,
): NavIntegrityRow {
  const updatedAt = latest?.updatedAt ?? null
  const heartbeatSeconds = latest?.heartbeatSeconds ?? null
  const staleness = navIsStale(updatedAt, heartbeatSeconds, now)
  const deviation: NavDeviation = marketDeviation(feed, latest?.nav ?? null, quote, now)
  return {
    key: feed.key,
    feedName: feed.feedName,
    address: feed.address,
    currency: feed.currency,
    latestNav: latest?.nav ?? null,
    observedAt: updatedAt != null && updatedAt > 0 ? new Date(updatedAt * 1000).toISOString() : null,
    heartbeatSeconds,
    ageSeconds: staleness.ageSeconds,
    staleness: staleness.reason ? 'unknown' : staleness.stale ? 'stale' : 'fresh',
    stalenessReason: staleness.reason,
    marketPriceUsd: finite(quote?.priceUsd),
    priceObservedAt: quote?.observedAt ?? null,
    deviationPct: deviation.deviationPct,
    deviationReason: deviation.reason,
    marketProvider: feed.marketProvider ?? null,
    marketProviderId: feed.marketProviderId ?? null,
    marketNameSeen: quote?.name ?? null,
    navScope: feed.navScope,
  }
}

export interface NavIntegrityBoard {
  rows: NavIntegrityRow[]
  monitored: number
  stale: number
  /** Feeds whose staleness could not be judged at all, which is NOT "fresh". */
  unknown: number
  /** Feeds carrying a computable price against NAV gap. */
  priced: number
  worstDeviationPct: number | null
}

/** Roll the rows up for the surface. `stale` and `unknown` are counted
 * separately on purpose: a feed with no readable clock has not been shown to be
 * fine, and folding it into "fresh" would hide exactly the failure this monitor
 * is for. */
export function navIntegrityBoard(rows: NavIntegrityRow[]): NavIntegrityBoard {
  const list = Array.isArray(rows) ? rows : []
  let worst: number | null = null
  for (const row of list) {
    if (row.deviationPct == null) continue
    if (worst == null || Math.abs(row.deviationPct) > Math.abs(worst)) worst = row.deviationPct
  }
  return {
    rows: list,
    monitored: list.length,
    stale: list.filter((r) => r.staleness === 'stale').length,
    unknown: list.filter((r) => r.staleness === 'unknown').length,
    priced: list.filter((r) => r.deviationPct != null).length,
    worstDeviationPct: worst,
  }
}
