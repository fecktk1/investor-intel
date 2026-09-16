import { assertEquals as eq, assert } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {
  realizedYield, navIsStale, isPublishableYield, needsReview, REVIEW_ABOVE_PCT,
} from './rwa-yield-realized.ts'
import type { NavRound } from './chainlink-nav.ts'

const DAY = 86400
/** A round series from NAV values, one per day, oldest first. */
const series = (navs: number[], endAt = 1_757_952_000): NavRound[] =>
  navs.map((nav, i) => ({ roundId: String(i + 1), nav, updatedAt: endAt - (navs.length - 1 - i) * DAY }))
const NOW = 1_757_952_000 * 1000

Deno.test('a falling nav is routed to review instead of being published as a negative yield', () => {
  // The real 2026-09-16 CRDYX shape: several consecutive steps down. With free
  // data a distribution and a credit loss are indistinguishable, so no number.
  const crdyx = realizedYield(series([7.889, 7.889, 7.7693, 7.7609, 7.7609, 7.7277, 7.6763]), { heartbeatSeconds: 86400, now: NOW })
  eq(crdyx.state, 'review_declining')
  eq(crdyx.annualizedPct, null)
  eq(crdyx.reason, 'unexplained_nav_decline')
  assert(crdyx.declines >= 3)
  assert((crdyx.largestDeclinePct ?? 0) > 0)
  assert(needsReview(crdyx))
  assert(!isPublishableYield(crdyx))

  // ACRED drifted down more gently on the same probe and gets the same treatment:
  // a small decline is still a decline we cannot explain.
  const acred = realizedYield(series([1112.09868, 1112.92272, 1113.11405, 1111.86824, 1110.57364, 1110.11753]), { heartbeatSeconds: 97200, now: NOW })
  eq(acred.state, 'review_declining')
  eq(acred.annualizedPct, null)

  // A series that dips and fully recovers has innocent endpoints, and is still
  // reviewed: the dip is the part nobody has explained.
  const dip = realizedYield(series([1.0, 0.98, 1.0, 1.01]), { heartbeatSeconds: 86400, now: NOW })
  eq(dip.state, 'review_declining')
  eq(dip.annualizedPct, null)
})

Deno.test('a flat nav publishes a realized yield of exactly zero rather than a blank', () => {
  // Probed 2026-09-16: VBILL and WTGXX both held exactly 1.0 across ten rounds.
  const flat = realizedYield(series([1, 1, 1, 1, 1, 1]), { heartbeatSeconds: 97200, now: NOW })
  eq(flat.state, 'published')
  eq(flat.annualizedPct, 0)
  eq(flat.reason, null)
  assert(isPublishableYield(flat))
  // The value is a real zero, not an absent one: a caller must not coalesce it.
  assert(flat.annualizedPct !== null)
  eq(flat.firstNav, 1)
  eq(flat.lastNav, 1)
})

Deno.test('a rising nav publishes a plausible annualized figure from the aggregator clocks', () => {
  // The real 2026-09-16 USTB series, which annualized to about 4.5 percent.
  const ustb = realizedYield(
    series([11.200497, 11.201558, 11.205962, 11.207063, 11.20816, 11.209249, 11.212488]),
    { heartbeatSeconds: 95400, now: NOW },
  )
  eq(ustb.state, 'published')
  assert(ustb.annualizedPct !== null && ustb.annualizedPct > 3 && ustb.annualizedPct < 8)
  eq(ustb.rounds, 7)
  eq(ustb.declines, 0)
  eq(ustb.windowDays, 6)
  // Dates come from the rounds themselves, never from our capture time.
  eq(ustb.lastAt, new Date(1_757_952_000 * 1000).toISOString())
})

Deno.test('an implausibly fast rise for its window is reviewed rather than published', () => {
  // The 2026-09-16 M^0 shape: real movement inside a very short window, which
  // annualizes into a number no cash instrument produces.
  const spike = realizedYield(
    [
      { roundId: '1', nav: 1.0, updatedAt: 1_757_692_800 },
      { roundId: '2', nav: 1.01, updatedAt: 1_757_779_200 },
      { roundId: '3', nav: 1.02408984, updatedAt: 1_757_865_600 },
    ],
    { heartbeatSeconds: 86400, now: NOW },
  )
  eq(spike.state, 'review_implausible')
  eq(spike.annualizedPct, null)
  eq(spike.reason, 'implausible_for_window')
  assert(needsReview(spike))
  assert(REVIEW_ABOVE_PCT > 0)
})

Deno.test('a stale feed is reported stale rather than served silently as a yield', () => {
  // Probed 2026-09-16: BTCY's newest round was 156 hours old against a 24 hour
  // heartbeat. A confident yield over a window that ended days ago is exactly
  // what the monitor exists to stop.
  const stale = realizedYield(series([1.0025, 1.0025, 1.0025, 1.0025], NOW / 1000 - 156 * 3600), { heartbeatSeconds: 86400, now: NOW })
  eq(stale.state, 'stale_feed')
  eq(stale.annualizedPct, null)
  eq(stale.reason, 'feed_stale_against_heartbeat')
  // The last thing we did see is still reported, so the row is not empty.
  assert(stale.lastAt !== null)
  eq(stale.lastNav, 1.0025)

  // Staleness is judged only against the feed's OWN published heartbeat.
  eq(navIsStale(1_757_000_000, 86400, 1_757_090_000_000).stale, true)
  eq(navIsStale(1_757_000_000, 86400, 1_757_040_000_000).stale, false)
  // No published heartbeat means no invented one, and that is not "fresh".
  const noHeartbeat = navIsStale(1_757_000_000, null, NOW)
  eq(noHeartbeat.stale, false)
  eq(noHeartbeat.reason, 'no_published_heartbeat')
  eq(navIsStale(null, 86400, NOW).reason, 'no_round_clock')
})

Deno.test('too little history is reported as such instead of annualizing noise', () => {
  const twoPoints = realizedYield(series([1.0, 1.001]), { heartbeatSeconds: 86400, now: NOW })
  eq(twoPoints.state, 'insufficient_history')
  eq(twoPoints.reason, 'too_few_rounds')
  eq(twoPoints.annualizedPct, null)

  // Three rounds inside a few hours is not a window worth annualizing.
  const tooShort = realizedYield(
    [
      { roundId: '1', nav: 1.0, updatedAt: 1_757_948_000 },
      { roundId: '2', nav: 1.0001, updatedAt: 1_757_950_000 },
      { roundId: '3', nav: 1.0002, updatedAt: 1_757_952_000 },
    ],
    { heartbeatSeconds: 86400, now: NOW },
  )
  eq(tooShort.state, 'insufficient_history')
  eq(tooShort.reason, 'window_too_short')

  // A non-positive nav is not a valuation and cannot be a ratio denominator.
  const zeroed = realizedYield(
    [
      { roundId: '1', nav: 0, updatedAt: 1_757_692_800 },
      { roundId: '2', nav: -1, updatedAt: 1_757_779_200 },
      { roundId: '3', nav: 1.01, updatedAt: 1_757_865_600 },
    ],
    { heartbeatSeconds: 86400, now: NOW },
  )
  eq(zeroed.state, 'insufficient_history')
  eq(realizedYield([], { now: NOW }).state, 'insufficient_history')
})
