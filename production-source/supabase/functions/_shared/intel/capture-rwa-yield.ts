// Investor Intel RWA yield capture lane: advertised against realized against
// the actual underlying instrument.
//
// Same contract as the other capture lanes (`capture-listings.ts`,
// `holder-tags.ts`): one bounded function, an explicit call ceiling, obeying
// `provider_schedule_policy`, never throwing (a failure becomes `{ error }`),
// and reaching the network ONLY through injected seams so the whole lane tests
// without a network or a database.
//
// NO PROVIDER CREDITS ARE SPENT HERE. Every source is keyless and free:
// Chainlink NAV over a public RPC, Treasury, the New York Fed, the ECB and SEC
// EDGAR. There is therefore no plan gate and no credit estimate; `credits` is
// reported as 0 and the ceiling that matters is the CALL ceiling below.
//
// What one run does:
//   1. ONE directory read, to find the mirror row for each registered feed.
//   2. Per registered feed, TWO batched RPC reads: one to prove the feed
//      (`description()` must match) and one to walk its recent rounds.
//   3. ONE read per distinct benchmark the registered feeds actually need.
//   4. TWO reads per advertised-only fund, against SEC EDGAR, with the agent
//      resolved by `rwa-sources/edgar-agent.ts`. With no agent configured the
//      fund is still a row, stating `user_agent_required`, and no call is made.
//
// Upper bound: 1 + 13 x 2 + 4 + 2 = 33 calls.
//
// THE CLOCK. `captured_at` is the hour WE asked, floored, so a retried or
// double-clicked run inside one hour lands on the same primary key. Every NAV
// figure additionally carries `nav_observed_at`, which is the AGGREGATOR's own
// round clock and is never our capture time.
//
// HONESTY RULES THIS LANE KEEPS:
//   * A feed the register does not list is not captured at all.
//   * A feed whose on-chain description disagrees with the mirror is stored as
//     `refused` with its reason, never as a NAV.
//   * A realized yield that is not publishable is stored with its state and a
//     NULL figure. A falling NAV never becomes a negative yield headline.
//   * A realized yield of exactly 0 is stored as 0. It is a measurement.
//   * A benchmark is only ever written beside a feed of the SAME currency.

import { hourBucket, iso, CAPTURE_PROVIDER, type CaptureDeps, type JobResult, type SchedulePolicyRow } from './capture-jobs.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import {
  NAV_DIRECTORY_URL, NAV_RPC_URL, NAV_RPC_TIMEOUT_MS, navDirectoryRows, validateNavFeed, readNavRounds,
  type NavRpc, type NavFeedCandidate,
} from './chainlink-nav.ts'
import {
  RWA_YIELD_FEEDS, RWA_ADVERTISED_ONLY, benchmarkForFeed, benchmarkMatchesCurrency,
  NAV_TIME_MEANING, NAV_TOTAL_RETURN_LIMIT, ADVERTISED_SCOPE, type BenchmarkKey,
} from './rwa-yield-register.ts'
import { realizedYield, navIsStale } from './rwa-yield-realized.ts'
import { readBenchmarkRates, type FetchText } from './rwa-benchmark-rates.ts'
import { readAdvertisedYield, type FetchTextWithHeaders } from './sec-nmfp-yield.ts'
import { resolveEdgarUserAgent } from './rwa-sources/edgar-agent.ts'

/** The pg_cron job that runs this lane (UTC), from migration
 * 20260916202000_intel_rwa_capture_cron.sql. Every six hours: registered NAV
 * feeds publish on a heartbeat of about a day, benchmarks once a business day
 * and N-MFP3 filings monthly, so four reads a day catch a stale feed within six
 * hours without re-reading an unchanged round every hour. Served by the read
 * view so an empty panel can say when it fills; asserted against the
 * migration by test. */
export const RWA_YIELD_CAPTURE_SCHEDULE = {
  rwa_yield: { job: 'intel-capture-rwa-yield-6h', cron: '29 1,7,13,19 * * *', cadence: 'every_6_hours', utc: '01:29, 07:29, 13:29, 19:29' },
} as const

export const RWA_YIELD_FEATURE = 'rwa_yield'
/** This lane's rows are not CoinMarketCap's, so they carry their own provider. */
export const RWA_YIELD_PROVIDER = 'chainlink'
export const NAV_TABLE = 'intel_rwa_nav_observations'
export const YIELD_TABLE = 'intel_rwa_yield_snapshots'
export const BENCHMARK_TABLE = 'intel_benchmark_rates'
/** Rounds walked per feed. Ten daily rounds is roughly a nine day window, which
 * is long enough to annualize and short enough to stay one batched call. */
export const ROUNDS_PER_FEED = 10
const MAX_UPSERT_ROWS = 500
/** Bytes of any single external document this lane will read. */
const MAX_DOCUMENT_BYTES = 4_000_000

export interface RwaYieldDeps extends CaptureDeps {
  fetchText?: FetchText
  fetchWithHeaders?: FetchTextWithHeaders
  rpcCall?: NavRpc
  policy?: SchedulePolicyRow[]
  /** The EDGAR agent. Omitted: resolved from the environment, then the
   * operating profile row. `null`: none, so the advertised side is refused. */
  edgarUserAgent?: string | null
}

// ─── Live seams ───────────────────────────────────────────────────────────────

const bounded = (body: string): string | null => (body.length > MAX_DOCUMENT_BYTES ? null : body)

/** Keyless GET. Returns null on any failure so a dead source degrades to a
 * named reason rather than ending the run. */
const liveFetchText: FetchText = async (url, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json, text/xml, */*' }, signal: controller.signal })
    if (!res.ok) return null
    return bounded(await res.text())
  } catch { return null } finally { clearTimeout(timer) }
}

/** The same, with the descriptive User-Agent EDGAR requires. */
const liveFetchWithHeaders: FetchTextWithHeaders = async (url, headers, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers: { accept: 'application/json, text/xml, */*', ...headers }, signal: controller.signal })
    if (!res.ok) return null
    return bounded(await res.text())
  } catch { return null } finally { clearTimeout(timer) }
}

const liveRpcCall: NavRpc = async (url, body, timeoutMs) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!res.ok) throw new Error(`rpc_http_${res.status}`)
    return await res.json()
  } finally { clearTimeout(timer) }
}

// ─── Small helpers, copied from the neighbouring lanes ────────────────────────

const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  let written = 0
  for (let start = 0; start < rows.length; start += MAX_UPSERT_ROWS) {
    const chunk = rows.slice(start, start + MAX_UPSERT_ROWS)
    try {
      const { error } = await db.from(table).upsert(chunk, { onConflict })
      if (error) return { rows: written, error: String(error.message || error).slice(0, 200) }
      written += chunk.length
    } catch (e) { return { rows: written, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
  }
  return { rows: written }
}

/** The lane is enabled unless an operator disabled its policy row. */
function lanePolicy(deps: RwaYieldDeps): { enabled: boolean } {
  const row = (deps.policy || []).find((r) => r?.feature === RWA_YIELD_FEATURE && (r.provider ?? RWA_YIELD_PROVIDER) === RWA_YIELD_PROVIDER)
  return { enabled: row ? row.enabled !== false : true }
}

/** Already captured inside this hour? A failed read never blocks the capture:
 * the write is an upsert keyed on the hour. */
// deno-lint-ignore no-explicit-any
async function capturedThisHour(db: any, capturedAt: string): Promise<boolean> {
  try {
    const { data, error } = await db.from(NAV_TABLE).select('feed_key').eq('captured_at', capturedAt).limit(1)
    if (error) return false
    return Array.isArray(data) ? data.length > 0 : !!data
  } catch { return false }
}

const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

// ─── The lane ─────────────────────────────────────────────────────────────────

/** Capture NAV, realized yield, the matching benchmark and, where a fund files
 * one, its advertised yield.
 *
 * Returns what the run DID. Nothing here promises that a figure is correct: a
 * feed that could not be proved, a series that cannot be published and a
 * benchmark that did not answer each occupy a row carrying its own reason. */
export async function captureRwaYield(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  deps: RwaYieldDeps,
): Promise<JobResult> {
  const job = 'rwa_yield'
  const capturedAt = hourBucket(now)
  const fetchedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  try {
    if (!lanePolicy(deps).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    if (await capturedThisHour(admin, capturedAt)) return { job, rows: 0, credits: 0, skipped: 'within_cadence', capturedAt }

    const fetchText = deps.fetchText || liveFetchText
    const fetchWithHeaders = deps.fetchWithHeaders || liveFetchWithHeaders
    const rpcCall = deps.rpcCall || liveRpcCall

    const ceiling = 1 + RWA_YIELD_FEEDS.length * 2 + 4 + RWA_ADVERTISED_ONLY.length * 2
    const ctx = ctxFor('rwa-yield', ceiling)
    const budget = callBudget(ctx, ceiling)
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    let calls = 0
    let partial: string | null = null

    // 1. The mirror, read once. A directory that does not answer does not end
    //    the run: every registered feed is still a row, stating that it could
    //    not be located this hour.
    calls += 1
    const directoryRaw = await fetchText(NAV_DIRECTORY_URL, NAV_RPC_TIMEOUT_MS)
    let byAddress = new Map<string, NavFeedCandidate>()
    if (!directoryRaw) partial = 'directory_unavailable'
    else {
      try {
        byAddress = new Map(navDirectoryRows(JSON.parse(directoryRaw)).map((row) => [row.address, row]))
      } catch { partial = 'directory_unreadable' }
    }

    // 2. Prove and read each registered feed.
    const navRows: Record<string, unknown>[] = []
    const yieldRows: Record<string, unknown>[] = []
    const neededBenchmarks = new Set<BenchmarkKey>()
    // deno-lint-ignore no-explicit-any
    const realizedByFeed = new Map<string, any>()
    let validated = 0, refused = 0

    for (const feed of RWA_YIELD_FEEDS) {
      const candidate = byAddress.get(feed.address)
      const base = {
        feed_key: feed.key, captured_at: capturedAt, feed_name: feed.feedName, contract_address: feed.address,
        source_url: NAV_RPC_URL, fetched_at: fetchedAt, scope: feed.navScope, time_meaning: NAV_TIME_MEANING,
      }
      if (!candidate) {
        // The register names it, the mirror did not this hour. That is a stated
        // reason, not a missing row.
        refused += 1
        navRows.push({ ...base, validation_state: 'refused', validation_reason: partial || 'not_in_directory', staleness: 'unknown', rounds_read: 0 })
        continue
      }
      if (calls + 1 > budget) { partial = partial || 'call_budget'; break }
      calls += 1
      const validation = await validateNavFeed(candidate, { rpcCall, timeoutMs: NAV_RPC_TIMEOUT_MS })
      if (validation.state !== 'validated' || !validation.latest) {
        refused += 1
        navRows.push({
          ...base, validation_state: 'refused', validation_reason: text(validation.reason, 120) || 'refused',
          on_chain_description: text(validation.onChainDescription, 200),
          heartbeat_seconds: candidate.heartbeatSeconds, por_auditor: candidate.porAuditor,
          staleness: 'unknown', rounds_read: 0,
        })
        continue
      }
      validated += 1

      let rounds = [validation.latest]
      if (calls + 1 <= budget) {
        calls += 1
        rounds = await readNavRounds(validation, { rpcCall, timeoutMs: NAV_RPC_TIMEOUT_MS }, ROUNDS_PER_FEED)
      } else partial = partial || 'call_budget'

      const realized = realizedYield(rounds, { heartbeatSeconds: candidate.heartbeatSeconds, now: nowMs })
      realizedByFeed.set(feed.key, realized)
      const staleness = navIsStale(validation.latest.updatedAt, candidate.heartbeatSeconds, nowMs)
      navRows.push({
        ...base,
        validation_state: 'validated', validation_reason: null,
        on_chain_description: text(validation.onChainDescription, 200),
        nav: validation.latest.nav, nav_decimals: validation.onChainDecimals,
        nav_observed_at: iso(validation.latest.updatedAt),
        round_id: text(validation.latest.roundId, 80),
        heartbeat_seconds: candidate.heartbeatSeconds,
        age_seconds: staleness.ageSeconds,
        staleness: staleness.reason ? 'unknown' : staleness.stale ? 'stale' : 'fresh',
        rounds_read: rounds.length, por_auditor: candidate.porAuditor,
      })

      const choice = benchmarkForFeed(feed)
      if (choice.key) neededBenchmarks.add(choice.key)
    }

    // 3. Benchmarks, one call each, only for what the feeds above actually need.
    const remaining = Math.max(0, budget - calls)
    const wanted = [...neededBenchmarks].slice(0, remaining)
    const benchmarks = wanted.length
      ? await readBenchmarkRates({ fetchText, now: nowMs }, wanted)
      : { rates: {}, failures: [], fetchedAt, calls: 0 }
    calls += benchmarks.calls
    if (wanted.length < neededBenchmarks.size) partial = partial || 'call_budget'
    if (benchmarks.failures.length) partial = partial || `benchmark_${benchmarks.failures[0].reason}`.slice(0, 60)

    const benchmarkRows = Object.values(benchmarks.rates).map((rate) => ({
      benchmark_key: rate.key, observed_at: rate.observedAt, rate_pct: rate.ratePct, currency: rate.currency,
      source_url: rate.sourceUrl, time_meaning: rate.timeMeaning, detail: rate.detail ?? null, fetched_at: fetchedAt,
    }))

    // 4. Build the yield row per feed, joining the benchmark ONLY when the
    //    currencies agree. The guard runs here as well as in the register so a
    //    future edit cannot leak a euro fund onto a dollar bill.
    for (const feed of RWA_YIELD_FEEDS) {
      const realized = realizedByFeed.get(feed.key)
      const choice = benchmarkForFeed(feed)
      const rate = choice.key ? benchmarks.rates[choice.key] : undefined
      const currencyOk = benchmarkMatchesCurrency(feed, choice.key)
      const benchmarkPct = rate && currencyOk ? rate.ratePct : null
      const realizedPct = realized?.state === 'published' ? realized.annualizedPct : null
      yieldRows.push({
        feed_key: feed.key, captured_at: capturedAt,
        currency: feed.currency, instrument_class: feed.instrumentClass,
        realized_state: realized?.state ?? 'insufficient_history',
        // A figure that is not publishable is stored as NULL beside its state.
        // A published 0 is stored as 0: `?? null` would be a bug here.
        realized_annualized_pct: realizedPct,
        realized_window_days: realized?.windowDays ?? null,
        realized_rounds: realized?.rounds ?? 0,
        realized_declines: realized?.declines ?? 0,
        realized_largest_decline_pct: realized?.largestDeclinePct ?? null,
        realized_reason: realized?.reason ?? 'feed_not_read',
        first_nav: realized?.firstNav ?? null, last_nav: realized?.lastNav ?? null,
        first_at: realized?.firstAt ?? null, last_at: realized?.lastAt ?? null,
        advertised_pct: null, advertised_observed_at: null, advertised_source_url: null,
        advertised_reason: feed.secSeriesId ? 'not_read_this_run' : 'advertised_not_published',
        benchmark_key: benchmarkPct == null ? null : choice.key,
        benchmark_pct: benchmarkPct,
        benchmark_observed_at: benchmarkPct == null ? null : rate!.observedAt,
        benchmark_currency: benchmarkPct == null ? null : rate!.currency,
        benchmark_reason: benchmarkPct != null ? null : choice.reason || (!currencyOk ? 'benchmark_currency_mismatch' : 'benchmark_unavailable'),
        // The whole point of the surface: the gap between what the fund actually
        // returned and what the underlying instrument paid. Only when both sides
        // exist and the currencies agree.
        spread_pct: realizedPct != null && benchmarkPct != null ? realizedPct - benchmarkPct : null,
        fetched_at: fetchedAt, scope: feed.navScope, total_return_limit: NAV_TOTAL_RETURN_LIMIT,
      })
    }

    // 5. Advertised-only funds: a primary-source yield with no NAV feed to
    //    compare it against, which is stated rather than hidden.
    let advertised = 0
    // The same resolved agent the issuer registry lane uses, read once per run
    // and only when there is a filing to read.
    const edgarUserAgent = !RWA_ADVERTISED_ONLY.length ? null
      : deps.edgarUserAgent !== undefined ? deps.edgarUserAgent
      : (await resolveEdgarUserAgent(admin)).userAgent
    for (const fund of RWA_ADVERTISED_ONLY) {
      if (calls + 2 > budget) { partial = partial || 'call_budget'; break }
      // A refusal for want of an agent issues no request, so it spends no calls.
      if (edgarUserAgent) calls += 2
      const result = await readAdvertisedYield(fund.secSeriesId, { fetchText: fetchWithHeaders, userAgent: edgarUserAgent })
      const found = 'yield' in result ? result.yield : null
      if (found) advertised += 1
      yieldRows.push({
        feed_key: fund.key, captured_at: capturedAt,
        currency: fund.currency, instrument_class: fund.instrumentClass,
        // There is no NAV feed for this fund, so there is no realized side. That
        // is a stated reason and never an implied zero.
        realized_state: 'insufficient_history', realized_annualized_pct: null,
        realized_window_days: null, realized_rounds: 0, realized_declines: 0,
        realized_largest_decline_pct: null, realized_reason: 'no_nav_feed',
        first_nav: null, last_nav: null, first_at: null, last_at: null,
        advertised_pct: found?.netYieldPct ?? null,
        advertised_observed_at: found?.observedAt ?? null,
        advertised_source_url: found?.sourceUrl ?? null,
        advertised_reason: found ? null : text((result as { reason?: string }).reason, 120) || 'advertised_unavailable',
        benchmark_key: null, benchmark_pct: null, benchmark_observed_at: null,
        benchmark_currency: null, benchmark_reason: 'no_realized_side_to_compare',
        spread_pct: null,
        fetched_at: fetchedAt, scope: ADVERTISED_SCOPE, total_return_limit: NAV_TOTAL_RETURN_LIMIT,
      })
    }

    // The NAV rows go first: they are what `within_cadence` reads, so a partial
    // write cannot make the next run believe the hour was already captured
    // before any evidence landed.
    const navWrite = await upsert(admin, NAV_TABLE, navRows, 'feed_key,captured_at')
    const yieldWrite = navWrite.error ? { rows: 0 } : await upsert(admin, YIELD_TABLE, yieldRows, 'feed_key,captured_at')
    const benchmarkWrite = navWrite.error ? { rows: 0 } : await upsert(admin, BENCHMARK_TABLE, benchmarkRows, 'benchmark_key,observed_at')

    return {
      job, rows: navWrite.rows + yieldWrite.rows + benchmarkWrite.rows,
      // Keyless sources only. No provider credits are consumed by this lane.
      credits: 0,
      capturedAt, calls,
      feeds: RWA_YIELD_FEEDS.length, validated, refused,
      benchmarks: benchmarkRows.length, advertised,
      published: yieldRows.filter((row) => row.realized_state === 'published').length,
      review: yieldRows.filter((row) => String(row.realized_state || '').startsWith('review_')).length,
      ...(partial ? { partial } : {}),
      ...(navWrite.error || yieldWrite.error ? { error: (navWrite.error || yieldWrite.error) as string } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, capturedAt, error: ((e as Error)?.message || 'rwa_yield_capture_failed').slice(0, 200) }
  }
}

/** Integration surface, wired in `intel-capture/index.ts` beside the other
 * lanes. The CoinMarketCap plan argument is accepted and ignored: this lane
 * spends no provider credits. */
export const RWA_YIELD_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  rwa_yield: (admin, ctxFor, now, _plan, deps) => captureRwaYield(admin, ctxFor, now, deps as RwaYieldDeps),
}

/** Exported so the read view and the tests name the provider the same way. */
export const RWA_YIELD_SOURCE_PROVIDER = RWA_YIELD_PROVIDER
export { CAPTURE_PROVIDER }
