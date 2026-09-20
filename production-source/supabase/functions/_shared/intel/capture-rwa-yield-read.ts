// Investor Intel RWA yield read view.
//
// Same contract as the other lane read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap, ordered
// newest first so that hitting a cap loses the OLDEST rows, and `coverage`
// reporting the window actually read. An empty table is an empty list with
// `asOf: null`, never an error and never a fabricated row.
//
// The view answers with ONE row per registered feed for the newest capture hour,
// carrying all three sides of the comparison (advertised, realized, benchmark)
// and the integrity state of the feed behind it. A feed that failed is still a
// row with its reason: a failure never shortens this list, because an absent
// feed reads as a feed with nothing wrong with it.

import { RWA_FEED_BY_KEY, MARKET_DEVIATION_SOURCE_NOTE, RWA_MARKET_SOURCE_LIMIT } from './rwa-yield-register.ts'
import { RWA_YIELD_CAPTURE_SCHEDULE } from './capture-rwa-yield.ts'
import { marketDeviation, DEVIATION_SCOPE, type NavQuote } from './rwa-nav-integrity.ts'

const FEED_CAP = 400
const HISTORY_DAYS = [7, 30, 90]
const HISTORY_CAP = 4000

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const RWA_YIELD_VIEWS = ['rwa_yield'] as const

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 400): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

/** Bounded read. A failed read is reported as a reason on an empty result. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** The headline figure a row may show, and nothing more.
 *
 * `realizedPct` is deliberately passed through as-is, INCLUDING an exact zero.
 * Treating 0 as absent here would erase the one measurement this engine is most
 * confident about, which is that a stable-NAV fund did not change. */
export function yieldHeadline(row: Record<string, unknown>): {
  state: string
  realizedPct: number | null
  benchmarkPct: number | null
  spreadPct: number | null
  publishable: boolean
  needsReview: boolean
} {
  const state = str(row.realized_state, 40) || 'insufficient_history'
  const publishable = state === 'published'
  const realizedPct = publishable ? num(row.realized_annualized_pct) : null
  const benchmarkPct = num(row.benchmark_pct)
  return {
    state,
    realizedPct,
    benchmarkPct,
    // The spread only exists when both sides do.
    spreadPct: realizedPct != null && benchmarkPct != null ? num(row.spread_pct) : null,
    publishable,
    needsReview: state.startsWith('review_'),
  }
}

/** One feed's row, assembled from its NAV observation and its yield snapshot. */
// deno-lint-ignore no-explicit-any
export function feedRow(nav: Record<string, any> | undefined, snapshot: Record<string, any> | undefined) {
  const source = snapshot || nav || {}
  const headline = yieldHeadline(snapshot || {})
  return {
    feedKey: str(source.feed_key, 60),
    feedName: str(nav?.feed_name, 120),
    contractAddress: str(nav?.contract_address, 80),
    currency: str(snapshot?.currency, 10),
    instrumentClass: str(snapshot?.instrument_class, 40),
    // Integrity.
    validationState: str(nav?.validation_state, 20),
    validationReason: str(nav?.validation_reason, 120),
    onChainDescription: str(nav?.on_chain_description, 200),
    nav: num(nav?.nav),
    navObservedAt: str(nav?.nav_observed_at, 40),
    heartbeatSeconds: num(nav?.heartbeat_seconds),
    ageSeconds: num(nav?.age_seconds),
    staleness: str(nav?.staleness, 20) || 'unknown',
    roundsRead: num(nav?.rounds_read) ?? 0,
    porAuditor: str(nav?.por_auditor, 120),
    // The three sides.
    advertisedPct: num(snapshot?.advertised_pct),
    advertisedObservedAt: str(snapshot?.advertised_observed_at, 40),
    advertisedSourceUrl: str(snapshot?.advertised_source_url, 400),
    advertisedReason: str(snapshot?.advertised_reason, 120),
    realizedState: headline.state,
    realizedPct: headline.realizedPct,
    realizedWindowDays: num(snapshot?.realized_window_days),
    realizedRounds: num(snapshot?.realized_rounds) ?? 0,
    realizedDeclines: num(snapshot?.realized_declines) ?? 0,
    realizedLargestDeclinePct: num(snapshot?.realized_largest_decline_pct),
    realizedReason: str(snapshot?.realized_reason, 120),
    firstNav: num(snapshot?.first_nav), lastNav: num(snapshot?.last_nav),
    firstAt: str(snapshot?.first_at, 40), lastAt: str(snapshot?.last_at, 40),
    benchmarkKey: str(snapshot?.benchmark_key, 40),
    benchmarkPct: headline.benchmarkPct,
    benchmarkObservedAt: str(snapshot?.benchmark_observed_at, 40),
    benchmarkCurrency: str(snapshot?.benchmark_currency, 10),
    benchmarkReason: str(snapshot?.benchmark_reason, 120),
    spreadPct: headline.spreadPct,
    publishable: headline.publishable,
    needsReview: headline.needsReview,
    // The market half of the integrity monitor, filled in by the read below.
    // Declared here with null defaults so a row always has the same shape, and
    // so a feed the join never reaches is an explicit "not mapped" rather than
    // an absent field the surface has to guess at.
    marketProvider: null as string | null,
    marketProviderId: null as string | null,
    marketName: null as string | null,
    marketNameSeen: null as string | null,
    marketPriceUsd: null as number | null,
    marketObservedAt: null as string | null,
    // The fund's logo, carried from the SAME catalogue row the price came from,
    // so the surface never issues a per-row image query and an image URL is never
    // built from a ticker. A feed with no mapped catalogue row carries nulls and
    // the surface draws a monogram, which is the correct answer for it.
    marketImageUrl: null as string | null,
    marketImageSourceUrl: null as string | null,
    deviationPct: null as number | null,
    deviationReason: 'market_price_not_mapped' as string | null,
    // Provenance travels with every row.
    scope: str(snapshot?.scope || nav?.scope, 400),
    timeMeaning: str(nav?.time_meaning, 400),
    totalReturnLimit: str(snapshot?.total_return_limit, 400),
    sourceUrl: str(nav?.source_url, 400),
    fetchedAt: str(snapshot?.fetched_at || nav?.fetched_at, 40),
  }
}

/** The newest captured hour, with one row per feed.
 *
 * `days` optionally adds a realized-yield history series per feed so the surface
 * can show whether a figure has been stable. */
// deno-lint-ignore no-explicit-any
export async function readRwaYield(db: any, params: { days?: number } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = Math.trunc(Number(params.days) || 30)
  const days = HISTORY_DAYS.includes(requested) ? requested : 30

  const [navRead, snapshotRead] = await Promise.all([
    readRows(() => db.from('intel_rwa_nav_observations')
      .select('feed_key,captured_at,feed_name,contract_address,validation_state,validation_reason,on_chain_description,nav,nav_decimals,nav_observed_at,round_id,heartbeat_seconds,age_seconds,staleness,rounds_read,por_auditor,source_url,fetched_at,scope,time_meaning')
      .order('captured_at', { ascending: false }).limit(FEED_CAP)),
    readRows(() => db.from('intel_rwa_yield_snapshots')
      .select('feed_key,captured_at,currency,instrument_class,realized_state,realized_annualized_pct,realized_window_days,realized_rounds,realized_declines,realized_largest_decline_pct,realized_reason,first_nav,last_nav,first_at,last_at,advertised_pct,advertised_observed_at,advertised_source_url,advertised_reason,benchmark_key,benchmark_pct,benchmark_observed_at,benchmark_currency,benchmark_reason,spread_pct,fetched_at,scope,total_return_limit')
      .order('captured_at', { ascending: false }).limit(FEED_CAP)),
  ])

  // The newest hour present in either table is the capture being rendered. Rows
  // from an older hour are not mixed in: two hours side by side would compare
  // figures nobody measured together.
  const stamps = [...navRead.rows, ...snapshotRead.rows].map((r) => str(r?.captured_at, 40)).filter((v): v is string => !!v).sort()
  const asOf = stamps.at(-1) ?? null
  if (!asOf) {
    return {
      view: 'rwa_yield', days, rows: [], summary: { feeds: 0, validated: 0, refused: 0, published: 0, review: 0, stale: 0, unknown: 0, priced: 0 },
      benchmarks: [], asOf: null, coverage: emptyCoverage(), reason: navRead.reason || snapshotRead.reason,
      // Nothing captured yet: when the lane runs, so the panel can say so.
      schedule: RWA_YIELD_CAPTURE_SCHEDULE,
    }
  }

  const navByFeed = new Map<string, Record<string, unknown>>()
  for (const row of navRead.rows) {
    const key = str(row?.feed_key, 60)
    if (!key || str(row?.captured_at, 40) !== asOf || navByFeed.has(key)) continue
    navByFeed.set(key, row)
  }
  const snapshotByFeed = new Map<string, Record<string, unknown>>()
  for (const row of snapshotRead.rows) {
    const key = str(row?.feed_key, 60)
    if (!key || str(row?.captured_at, 40) !== asOf || snapshotByFeed.has(key)) continue
    snapshotByFeed.set(key, row)
  }

  const keys = [...new Set([...navByFeed.keys(), ...snapshotByFeed.keys()])].sort()
  const rows = keys.map((key) => feedRow(navByFeed.get(key), snapshotByFeed.get(key)))

  // The benchmark rows behind whatever the feeds were compared against.
  const usedKeys = [...new Set(rows.map((r) => r.benchmarkKey).filter((v): v is string => !!v))]
  const benchmarkRead = usedKeys.length
    ? await readRows(() => db.from('intel_benchmark_rates')
        .select('benchmark_key,observed_at,rate_pct,currency,source_url,time_meaning')
        .in('benchmark_key', usedKeys).order('observed_at', { ascending: false }).limit(HISTORY_CAP))
    : { rows: [], reason: null }
  const benchmarkByKey = new Map<string, Record<string, unknown>>()
  for (const row of benchmarkRead.rows) {
    const key = str(row?.benchmark_key, 40)
    if (!key || benchmarkByKey.has(key)) continue
    benchmarkByKey.set(key, row)
  }

  // ── The market half of the NAV integrity monitor ──
  //
  // Read at REQUEST time rather than stored at capture time, so the quote is as
  // fresh as the catalogue is and a deviation is never served from a figure that
  // went stale inside our own table.
  //
  // The join is on the catalogue's provider id and the fund NAME is re-verified
  // before any figure is computed. It is never on a ticker: in this very
  // catalogue `M` is MemeCore and Mantis, not the fund whose NAV we read, and
  // `USTBL` matches two different rows. A feed with no registered id, no
  // catalogue row, or a drifted name gets its own reason instead of a number.
  const marketIds = [...new Set(rows
    .map((row) => (row.feedKey ? RWA_FEED_BY_KEY[row.feedKey]?.marketProviderId ?? null : null))
    .filter((v): v is string => !!v))]
  const marketRead = marketIds.length
    ? await readRows(() => db.from('market_assets')
        // The image columns ride along on the read that already had to happen for
        // the price. The mirrored copy first, the provider's own URL second; the
        // surface picks in that order and falls back to a monogram.
        .select('source_provider,provider_id,name,current_price,as_of,cached_image_url,image_url')
        .eq('source_provider', 'coingecko').eq('in_current_catalog', true)
        .in('provider_id', marketIds).limit(FEED_CAP))
    : { rows: [], reason: null }
  const quoteById = new Map<string, NavQuote>()
  const imageById = new Map<string, { cached: string | null; source: string | null }>()
  for (const entry of marketRead.rows) {
    const id = str(entry?.provider_id, 200)
    if (!id || quoteById.has(id)) continue
    imageById.set(id, { cached: str(entry?.cached_image_url, 500), source: str(entry?.image_url, 500) })
    quoteById.set(id, {
      priceUsd: num(entry?.current_price),
      // The catalogue's own as-of, never our read time.
      observedAt: str(entry?.as_of, 40),
      name: str(entry?.name, 200),
      provider: str(entry?.source_provider, 40),
      providerId: id,
    })
  }
  for (const row of rows) {
    const feed = row.feedKey ? RWA_FEED_BY_KEY[row.feedKey] : null
    // A captured feed the register no longer lists is not priced against
    // anything: the register is what decides which feeds exist.
    if (!feed) { row.deviationReason = 'feed_not_registered'; continue }
    const quote = feed.marketProviderId ? quoteById.get(feed.marketProviderId) ?? null : null
    const deviation = marketDeviation(feed, row.nav, quote, at(now))
    row.marketProvider = feed.marketProvider
    row.marketProviderId = feed.marketProviderId
    row.marketName = feed.marketName
    row.marketNameSeen = quote?.name ?? null
    row.marketPriceUsd = quote?.priceUsd ?? null
    row.marketObservedAt = quote?.observedAt ?? null
    const image = feed.marketProviderId ? imageById.get(feed.marketProviderId) ?? null : null
    row.marketImageUrl = image?.cached ?? null
    row.marketImageSourceUrl = image?.source ?? null
    row.deviationPct = deviation.deviationPct
    row.deviationReason = deviation.reason
  }

  const capturedStamps = [...navByFeed.values(), ...snapshotByFeed.values()]
    .map((r) => str((r as Record<string, unknown>).captured_at, 40)).filter((v): v is string => !!v).sort()

  return {
    view: 'rwa_yield', days,
    rows,
    summary: {
      feeds: rows.length,
      validated: rows.filter((r) => r.validationState === 'validated').length,
      refused: rows.filter((r) => r.validationState === 'refused').length,
      published: rows.filter((r) => r.publishable).length,
      review: rows.filter((r) => r.needsReview).length,
      stale: rows.filter((r) => r.staleness === 'stale').length,
      // Counted apart from stale on purpose: a feed we could not judge has not
      // been shown to be healthy.
      unknown: rows.filter((r) => r.staleness === 'unknown').length,
      // Feeds carrying a computable price against NAV gap. The rest each say why.
      priced: rows.filter((r) => r.deviationPct != null).length,
    },
    benchmarks: [...benchmarkByKey.values()].map((row) => ({
      key: str(row.benchmark_key, 40), ratePct: num(row.rate_pct), observedAt: str(row.observed_at, 40),
      currency: str(row.currency, 10), sourceUrl: str(row.source_url, 400), timeMeaning: str(row.time_meaning, 400),
    })),
    // The two halves of a deviation are two different sources, so the mix is
    // stated on the payload and rendered beside the figure.
    marketSourceNote: MARKET_DEVIATION_SOURCE_NOTE,
    marketSourceLimit: RWA_MARKET_SOURCE_LIMIT,
    deviationScope: DEVIATION_SCOPE,
    marketReason: marketRead.reason,
    schedule: RWA_YIELD_CAPTURE_SCHEDULE,
    asOf,
    coverage: {
      from: capturedStamps[0] ?? null, to: capturedStamps.at(-1) ?? null, count: rows.length,
      truncated: navRead.rows.length >= FEED_CAP || snapshotRead.rows.length >= FEED_CAP,
    },
    reason: navRead.reason || snapshotRead.reason || benchmarkRead.reason,
    generatedAt: new Date(at(now)).toISOString(),
  }
}

/** Integration surface consumed by `intel-capture/index.ts`, keyed by view name. */
export const RWA_YIELD_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_yield: (db, body, now) => readRwaYield(db, body, now),
}
