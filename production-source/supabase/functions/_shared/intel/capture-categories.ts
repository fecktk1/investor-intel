// Investor Intel — CoinMarketCap category, category-membership and network-stat
// capture lanes (CMC plan proposals 22, 27 and 29).
//
// Same contract as `capture-jobs.ts`: one function per lane, every lane bounded
// by an explicit call ceiling, obeying `provider_schedule_policy` (a disabled
// feature is skipped with `policy_disabled`, a run inside the feature's cadence
// with `within_cadence`), never throwing — a failure becomes `{ error }` on the
// result. Nothing here calls CoinMarketCap directly: the transport is injected
// as `deps.request`, so the module tests without a network or a database.
//
// Credits reported are the UPPER bound (the number of provider calls a run may
// issue, priced by the registry). The shared transport serves a fresh cached
// snapshot for 0 credits, so the billed total is never higher.
//
// The helpers `capture-jobs.ts` does not export (num/int/text, dedupe, upsert,
// newestAt, guardJob, failed) are copied here verbatim rather than changing that
// module: other capture lanes are being added concurrently against it.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, hourBucket, utcDate, iso, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'

/** The registry caps `limit` at 250 and `cmcRows` keeps at most 250 rows of a
 * page, so one categories page IS the bounded universe: a second page would
 * double the hourly credit line for the tail of the list, which no read uses. */
export const CATEGORY_LIST_LIMIT = 250
/** Members are captured for the largest categories only; 40 calls a day is the
 * whole membership budget for this lane. */
export const MEMBER_CATEGORIES = 40
export const MEMBER_LIMIT = 200
/** Growth-only chain statistics. The cost probe returned 403/1006 below Growth,
 * so the lane is skipped with a reason instead of spending a call to find out. */
export const NETWORK_STAT_IDS = ['1', '1027', '2'] as const   // BTC, ETH, LTC

const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500
/** Cadence a lane falls back to when its `provider_schedule_policy` row is
 * missing. `schedulePolicy` defaults an unknown feature to one hour, which for
 * the daily membership lane would be 40 credits AN HOUR, so these lanes carry
 * their own designed cadence and only take the table's when a row exists. */
const LANE_CADENCE: Record<string, number> = { categories: 3600, category_members: 86400, network_stats: 3600 }

function lanePolicy(deps: CaptureDeps, feature: string): { enabled: boolean; cadenceSeconds: number } {
  const row = (deps.policy || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE[feature] ?? 3600 }
  const policy = schedulePolicy(deps.policy, feature)
  return { enabled: policy.enabled, cadenceSeconds: policy.cadenceSeconds }
}

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const count = (v: unknown): number | null => { const n = int(v); return n == null || n < 0 ? null : n }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }

/** Newest value of a timestamp column, or null when the table is empty or the
 * read failed. A failed read never blocks a capture: the write is idempotent. */
// deno-lint-ignore no-explicit-any
async function newestAt(db: any, table: string, column: string, filters: [string, unknown][] = []): Promise<number | null> {
  try {
    let q = db.from(table).select(column)
    for (const [key, value] of filters) q = q.eq(key, value)
    const { data, error } = await q.order(column, { ascending: false }).limit(1)
    if (error) return null
    const row = Array.isArray(data) ? data[0] : data
    const parsed = Date.parse(String(row?.[column] ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  } catch { return null }
}

// deno-lint-ignore no-explicit-any
async function guardJob(db: any, job: string, feature: string, deps: CaptureDeps, now: Date,
  freshness: { table: string; column: string; filters?: [string, unknown][] }): Promise<JobResult | null> {
  const policy = lanePolicy(deps, feature)
  if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
  const newest = await newestAt(db, freshness.table, freshness.column, freshness.filters || [])
  if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
    return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
  }
  return null
}

/** Primary keys reject a duplicate inside one statement, so a provider page that
 * repeats an identity is collapsed to its last occurrence before the write. */
function dedupe<T>(rows: T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>()
  for (const row of rows) byKey.set(key(row), row)
  return [...byKey.values()]
}

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

const failed = (job: string, credits: number, e: unknown): JobResult =>
  ({ job, rows: 0, credits, error: ((e as Error)?.message || 'capture_failed').slice(0, 200) })

/** How many provider calls this context permits. A context with no explicit
 * budget still runs the lane's own ceiling; it never runs unbounded. */
const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

// ─── 1. Category list (hourly) ────────────────────────────────────────────────
// `/v1/cryptocurrency/categories` returns the whole category board in one page:
// name, title, token count, average price change and the aggregate market cap /
// volume with their 24h changes. One hourly row per category is the series every
// category read draws on.
// deno-lint-ignore no-explicit-any
export async function captureCategories(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'categories'
  const credits = estimateCmcCredits('categories', { limit: String(CATEGORY_LIST_LIMIT) })
  try {
    const skip = await guardJob(db, job, 'categories', deps, now, { table: 'intel_category_snapshots', column: 'captured_at' })
    if (skip) return skip
    const ctx = ctxFor('categories', 1)
    if (callBudget(ctx, 1) < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }
    const result = await deps.request('categories', { limit: CATEGORY_LIST_LIMIT, start: 1 }, ctx).catch(() => null)
    if (!result?.payload) return { job, rows: 0, credits, error: result?.reason || 'provider_unavailable' }
    const capturedAt = hourBucket(now)
    const rows = dedupe(cmcRows('categories', result.payload).rows.map((row: Record<string, unknown>) => ({
      provider: CAPTURE_PROVIDER, category_id: text(row?.id, 100) ?? '', captured_at: capturedAt,
      name: text(row?.name, 200), title: text(row?.title, 200),
      num_tokens: count(row?.num_tokens),
      avg_price_change: num(row?.avg_price_change),
      market_cap: num(row?.market_cap), market_cap_change: num(row?.market_cap_change),
      volume: num(row?.volume), volume_change: num(row?.volume_change),
      observed_at: iso(row?.last_updated),
    })).filter((row) => !!row.category_id), (r) => r.category_id)
    if (!rows.length) return { job, rows: 0, credits, capturedAt, skipped: 'no_reported_categories' }
    const written = await upsert(db, 'intel_category_snapshots', rows, 'provider,category_id,captured_at')
    return { job, rows: written.rows, credits, capturedAt, categories: rows.length, ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, credits, e) }
}

// ─── 2. Category membership (daily) ───────────────────────────────────────────
// `/v1/cryptocurrency/category` costs one credit per category, so membership is
// captured for the largest categories of the newest snapshot only — 40 calls, 40
// credits a day. A run that cannot reach every category writes what it has and
// reports the rest as `partial`, never a silently short membership.
// deno-lint-ignore no-explicit-any
export async function captureCategoryMembers(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), deps: CaptureDeps): Promise<JobResult> {
  const job = 'category_members'
  let credits = 0
  try {
    const skip = await guardJob(db, job, 'category_members', deps, now, { table: 'intel_category_members', column: 'created_at' })
    if (skip) return skip
    // The category board is the source of "largest": membership never re-derives
    // a ranking of its own, so the two lanes cannot disagree about what is top.
    const latest = await db.from('intel_category_snapshots').select('captured_at')
      .order('captured_at', { ascending: false }).limit(1)
    if (latest?.error) return { job, rows: 0, credits: 0, error: String(latest.error.message || latest.error).slice(0, 200) }
    const capturedAt = text((Array.isArray(latest?.data) ? latest.data[0] : latest?.data)?.captured_at, 40)
    if (!capturedAt) return { job, rows: 0, credits: 0, skipped: 'no_category_snapshot' }
    const top = await db.from('intel_category_snapshots').select('category_id,name,market_cap')
      .eq('provider', CAPTURE_PROVIDER).eq('captured_at', capturedAt)
      .order('market_cap', { ascending: false, nullsFirst: false }).limit(MEMBER_CATEGORIES)
    if (top?.error) return { job, rows: 0, credits: 0, error: String(top.error.message || top.error).slice(0, 200) }
    // deno-lint-ignore no-explicit-any
    const categories = ((top?.data || []) as any[]).map((row) => text(row?.category_id, 100)).filter((v): v is string => !!v)
    if (!categories.length) return { job, rows: 0, credits: 0, skipped: 'no_category_snapshot' }

    const ctx = ctxFor('category-members', MEMBER_CATEGORIES)
    const budget = callBudget(ctx, MEMBER_CATEGORIES)
    const snapshotDate = utcDate(now)
    const rows: Record<string, unknown>[] = []
    let reason: string | null = null, requested = 0, skippedForBudget = 0
    for (const categoryId of categories) {
      if (requested >= budget) { skippedForBudget += 1; continue }
      requested += 1
      credits += estimateCmcCredits('category', { id: categoryId, limit: String(MEMBER_LIMIT) })
      const result = await deps.request('category', { id: categoryId, limit: MEMBER_LIMIT, start: 1 }, ctx).catch(() => null)
      if (!result?.payload) { reason = reason || result?.reason || 'provider_unavailable'; continue }
      // deno-lint-ignore no-explicit-any
      for (const coin of cmcRows('category', result.payload).rows as any[]) {
        const providerId = coin?.id == null ? null : String(coin.id)
        if (!providerId || providerId === 'null') continue
        rows.push({
          provider: CAPTURE_PROVIDER, category_id: categoryId, snapshot_date: snapshotDate,
          provider_id: providerId, symbol: text(coin?.symbol, 50),
          cmc_rank: (int(coin?.cmc_rank) ?? 0) > 0 ? int(coin?.cmc_rank) : null,
        })
      }
    }
    if (skippedForBudget) reason = reason || 'call_budget'
    if (!rows.length) return { job, rows: 0, credits, snapshotDate, error: reason || 'provider_unavailable' }
    const written = await upsert(db, 'intel_category_members', dedupe(rows, (r) => `${r.category_id}|${r.provider_id}`), 'provider,category_id,snapshot_date,provider_id')
    return {
      job, rows: written.rows, credits, snapshotDate, sourceCapturedAt: capturedAt,
      categories: requested, pendingCategories: skippedForBudget,
      ...(reason ? { partial: reason } : {}), ...(written.error ? { error: written.error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

// ─── 3. Chain network statistics (hourly, Growth and above) ───────────────────
/** `/v1/blockchain/statistics/latest` answers with an id-keyed object, not a
 * list, and `cmcRows` would wrap that whole map as a single row. */
// deno-lint-ignore no-explicit-any
export function blockchainStatRows(payload: any): Record<string, any>[] {
  const data = payload?.data ?? payload
  const list = Array.isArray(data) ? data : (data && typeof data === 'object' ? Object.values(data) : [])
  return list.flat().filter((v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)).slice(0, 50) as Record<string, any>[]
}

// deno-lint-ignore no-explicit-any
export async function captureNetworkStats(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'network_stats'
  try {
    // A capability above the current plan is never attempted: below Growth the
    // table stays empty and the read says so, rather than showing a flat line.
    if (!planAllows(plan, 'growth')) return { job, rows: 0, credits: 0, skipped: 'plan_below_growth' }
    const skip = await guardJob(db, job, 'network_stats', deps, now, { table: 'intel_network_stats_snapshots', column: 'captured_at' })
    if (skip) return skip
    const ctx = ctxFor('network-stats', 1)
    if (callBudget(ctx, 1) < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }
    const id = NETWORK_STAT_IDS.join(',')
    const credits = estimateCmcCredits('blockchainStats', { id })
    const result = await deps.request('blockchainStats', { id }, ctx).catch(() => null)
    if (!result?.payload) return { job, rows: 0, credits, error: result?.reason || 'provider_unavailable' }
    const capturedAt = hourBucket(now)
    const rows = dedupe(blockchainStatRows(result.payload).map((row) => {
      const values = {
        hashrate_24h: num(row?.hashrate_24h), difficulty: num(row?.difficulty), tps_24h: num(row?.tps_24h),
        pending_transactions: num(row?.pending_transactions), total_blocks: num(row?.total_blocks),
        total_transactions: num(row?.total_transactions), block_reward_static: num(row?.block_reward_static),
      }
      return {
        provider_id: row?.id == null ? '' : String(row.id), captured_at: capturedAt, symbol: text(row?.symbol, 50),
        ...values,
        // Only the fields the payload actually reports are kept in `raw`; a
        // metric the chain does not publish stays absent, never an invented 0.
        raw: Object.fromEntries(Object.entries(values).filter(([, v]) => v != null)),
      }
    }).filter((row) => !!row.provider_id && row.provider_id !== 'null'), (r) => String(r.provider_id))
    if (!rows.length) return { job, rows: 0, credits, capturedAt, skipped: 'no_reported_chains' }
    const written = await upsert(db, 'intel_network_stats_snapshots', rows, 'provider_id,captured_at')
    return { job, rows: written.rows, credits, capturedAt, ...(written.error ? { error: written.error } : {}) }
  } catch (e) { return failed(job, 1, e) }
}

/** Integration surface. The `intel-capture` Edge Function maps an op name onto
 * one of these; the reviewer wires them in alongside the other lanes. */
export const CATEGORY_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  categories: (admin, ctxFor, now, _plan, deps) => captureCategories(admin, ctxFor, now, deps),
  category_members: (admin, ctxFor, now, _plan, deps) => captureCategoryMembers(admin, ctxFor, now, deps),
  network_stats: (admin, ctxFor, now, plan, deps) => captureNetworkStats(admin, ctxFor, now, plan, deps),
}
