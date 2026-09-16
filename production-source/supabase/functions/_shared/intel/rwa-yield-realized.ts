// Investor Intel: realized yield from a NAV series, and the honesty gate that
// decides whether it may be published at all.
//
// THE PROBLEM THIS MODULE EXISTS TO REFUSE TO SOLVE.
// A NAV that falls can mean the fund paid a distribution, or it can mean the
// fund took a credit loss. With free data those two are INDISTINGUISHABLE. On
// 2026-09-16 the WisdomTree private-credit feed (CRDYX) fell across several
// consecutive rounds, which annualizes to a large negative number; Apollo's
// ACRED drifted down more gently. Rendering either as a negative yield headline
// would state a fact nobody has established. So a series that falls is LABELLED
// UNEXPLAINED and routed to human review, and `annualizedPct` stays null.
//
// A rise can be just as unexplainable. Probed 2026-09-16, the M^0 feed moved up
// and down between rounds inside a 3.6 day window, which annualizes to about 92
// percent. That is noise amplified by a short window, not a yield, so a rise
// above a stated ceiling is also routed to review rather than published.
//
// WHAT IS PUBLISHED. A series that never falls, over a long enough window, with
// a plausible result. Its realized yield may be exactly 0, and a 0 is published
// as 0: probed 2026-09-16, VBILL and WTGXX both held exactly 1.0 across ten
// rounds. That is a real measurement of no NAV change, never a blank, and the
// accompanying scope string says why a flat NAV is not the same as no return.

import type { NavRound } from './chainlink-nav.ts'

/** Distinct dated rounds required before any yield is computed. Two points is a
 * line through noise; three is the least that shows a direction. */
export const MIN_ROUNDS = 3
/** Shortest window that may be annualized. Annualizing a sub-two-day window
 * multiplies a rounding step in the last decimal into whole percentage points. */
export const MIN_WINDOW_DAYS = 2
/** A realized NAV yield above this is not explainable from free data, so it goes
 * to review instead of onto the surface. Set from the live probe: registered
 * cash instruments landed between 2.0 and 4.9 percent, and the only figure that
 * cleared 25 was the oscillating feed described above. */
export const REVIEW_ABOVE_PCT = 25

export type RealizedState =
  /** Computed, plausible, monotonic. Safe to render, including a plain 0. */
  | 'published'
  /** The NAV fell. Never rendered as a negative yield. */
  | 'review_declining'
  /** The NAV rose implausibly fast for the window. */
  | 'review_implausible'
  /** Not enough dated rounds, or too short a window, to annualize. */
  | 'insufficient_history'
  /** The feed itself is stale against its own heartbeat. */
  | 'stale_feed'

export interface RealizedYield {
  state: RealizedState
  /** Annualized percent, present ONLY when state is `published`. Exactly 0 is a
   * value, not an absence, and callers must not coalesce it away. */
  annualizedPct: number | null
  windowDays: number | null
  firstNav: number | null
  lastNav: number | null
  /** ISO instants taken from the aggregator's own round clocks. */
  firstAt: string | null
  lastAt: string | null
  rounds: number
  /** How many consecutive steps fell. The evidence behind `review_declining`. */
  declines: number
  /** The deepest single step down, as a percent of the prior NAV. */
  largestDeclinePct: number | null
  /** Machine reason. Always set unless the figure is published. */
  reason: string | null
}

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

const empty = (state: RealizedState, reason: string, extra: Partial<RealizedYield> = {}): RealizedYield => ({
  state, annualizedPct: null, windowDays: null, firstNav: null, lastNav: null,
  firstAt: null, lastAt: null, rounds: 0, declines: 0, largestDeclinePct: null, reason, ...extra,
})

/** Is the newest round older than the feed's own published heartbeat?
 *
 * The heartbeat is the feed's OWN contract about how often it updates, so it is
 * the only defensible staleness bound. A feed with no published heartbeat is not
 * judged stale by an invented one. */
export function navIsStale(
  newestUpdatedAt: number | null,
  heartbeatSeconds: number | null,
  now: number,
): { stale: boolean; ageSeconds: number | null; reason: string | null } {
  if (newestUpdatedAt == null || !Number.isFinite(newestUpdatedAt) || newestUpdatedAt <= 0) {
    return { stale: false, ageSeconds: null, reason: 'no_round_clock' }
  }
  const ageSeconds = Math.floor(now / 1000) - newestUpdatedAt
  if (heartbeatSeconds == null || heartbeatSeconds <= 0) return { stale: false, ageSeconds, reason: 'no_published_heartbeat' }
  return { stale: ageSeconds > heartbeatSeconds, ageSeconds, reason: null }
}

/** Realized yield over the supplied rounds, with the publication gate applied.
 *
 * `rounds` must be oldest first, which is what `readNavRounds` returns. Rounds
 * with a non-positive NAV are dropped before anything is computed: a zero NAV
 * cannot be a ratio denominator and is not a valuation. */
export function realizedYield(
  rounds: NavRound[],
  options: { heartbeatSeconds?: number | null; now?: number } = {},
): RealizedYield {
  const now = options.now ?? Date.now()
  const points = (Array.isArray(rounds) ? rounds : [])
    .filter((r) => r && Number.isFinite(r.nav) && r.nav > 0 && Number.isFinite(r.updatedAt) && r.updatedAt > 0)
    .sort((a, b) => a.updatedAt - b.updatedAt)

  const newest = points.at(-1)?.updatedAt ?? null
  const staleness = navIsStale(newest, options.heartbeatSeconds ?? null, now)
  // Staleness is checked BEFORE the maths. A feed that stopped updating would
  // otherwise report a confident yield over a window that ended days ago, which
  // is precisely the failure the monitor exists to surface.
  if (staleness.stale) {
    return empty('stale_feed', 'feed_stale_against_heartbeat', {
      rounds: points.length,
      lastAt: newest != null ? iso(newest) : null,
      lastNav: points.at(-1)?.nav ?? null,
    })
  }

  if (points.length < MIN_ROUNDS) return empty('insufficient_history', 'too_few_rounds', { rounds: points.length })

  const first = points[0], last = points[points.length - 1]
  const windowDays = (last.updatedAt - first.updatedAt) / 86400
  const base: Partial<RealizedYield> = {
    windowDays, firstNav: first.nav, lastNav: last.nav,
    firstAt: iso(first.updatedAt), lastAt: iso(last.updatedAt), rounds: points.length,
  }
  if (!(windowDays >= MIN_WINDOW_DAYS)) return empty('insufficient_history', 'window_too_short', base)

  // Every consecutive step, not just the endpoints. A series that dips and
  // recovers has the same endpoints as one that never moved, and the dip is the
  // thing we are not allowed to explain away.
  let declines = 0
  let largestDeclinePct: number | null = null
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1].nav, current = points[i].nav
    if (current < previous) {
      declines += 1
      const dropPct = ((previous - current) / previous) * 100
      if (largestDeclinePct == null || dropPct > largestDeclinePct) largestDeclinePct = dropPct
    }
  }
  if (declines > 0) {
    return { ...empty('review_declining', 'unexplained_nav_decline', base), declines, largestDeclinePct }
  }

  const ratio = last.nav / first.nav
  const annualizedPct = (Math.pow(ratio, 365 / windowDays) - 1) * 100
  if (!Number.isFinite(annualizedPct)) return empty('insufficient_history', 'not_computable', base)
  if (annualizedPct > REVIEW_ABOVE_PCT) {
    return { ...empty('review_implausible', 'implausible_for_window', base), declines, largestDeclinePct }
  }
  return {
    state: 'published',
    // A flat series gives exactly 0 here and is returned as 0, never as null.
    annualizedPct,
    windowDays, firstNav: first.nav, lastNav: last.nav,
    firstAt: iso(first.updatedAt), lastAt: iso(last.updatedAt), rounds: points.length,
    declines: 0, largestDeclinePct: null, reason: null,
  }
}

/** Is this figure safe to render as a yield headline? The surface asks this
 * rather than testing the state string in several places. */
export const isPublishableYield = (realized: Pick<RealizedYield, 'state'>): boolean => realized.state === 'published'

/** Does this figure need a human to look at it? */
export const needsReview = (realized: Pick<RealizedYield, 'state'>): boolean =>
  realized.state === 'review_declining' || realized.state === 'review_implausible'
