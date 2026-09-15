// Investor Intel — meme launch-stage capture lane (CMC plan proposal 30).
//
// Same contract as `capture-jobs.ts` and the other Stage 3/4 lanes: one function
// per lane, bounded by an explicit call ceiling, obeying
// `provider_schedule_policy` (a disabled feature is skipped with
// `policy_disabled`, a run inside the feature's cadence with `within_cadence`),
// never throwing — a failure becomes `{ error }` on the result. Nothing here
// calls CoinMarketCap directly: the transport is injected as `deps.request`, so
// the module tests without a network or a database.
//
// What one hourly run does:
//   ONE `dexMeme` call per VERIFIED CMC DEX platform, probed in the order
//   solana (16), base (199), ethereum (1), arbitrum (51) — Solana first because
//   it is where the launchpads the audit names actually live. `pageSize` is 25,
//   which is the provider's ceiling for a discovery page, and the response
//   carries three arrays: `newCreations`, `aboutGraduates`, `graduates`. Each is
//   1 credit, so a run costs at most 4 credits: 96 a day, ~2,880 a month against
//   the scaled `attention` feature cap. The shared transport serves a still-fresh
//   snapshot for 0 credits, so the billed total is never higher.
//
// FOUR.MEME IS NOT COVERED. The audit names Pump.fun, Moonshot and Four.meme.
// Four.meme launches on BNB Chain, which is NOT one of the four platforms this
// platform has verified CMC DEX evidence for (`CMC_DEX_NETWORKS`), so no
// Four.meme cohort is captured and none is implied. Widening the lane is the
// same work as widening `CMC_DEX_NETWORKS` (proposal 31): platform validation
// through `dexPlatforms` first, a migration second.
//
// HONESTY RULES this lane keeps:
//   * The provider publishes NO clock for a discovery list. Our capture time is
//     the clock, floored to the hour, and the table names it `captured_at`.
//   * `first_seen_at` is the FIRST HOUR WE SAW the contract in any stage, not a
//     deployment time. A contract we have never seen before is first seen now.
//   * A stage TRANSITION is recorded only when the contract's stage differs from
//     the stage of its own previous snapshot. A contract that simply stays in a
//     stage writes no transition, and a contract we have not seen before writes
//     no transition either — there is no "from" to record.
//   * A contract that appears in more than one array of the same response keeps
//     its FURTHEST stage (graduates > aboutGraduates > newCreations); the
//     primary key permits exactly one stage per contract per hour.
//   * The previous-snapshot read is bounded. When it is truncated the job says
//     so (`priorTruncated`), because a truncated read can make a contract look
//     newly first seen when it is not.
//   * `dexMeme` is a Startup capability. Below Startup the lane is skipped with
//     `plan_below_startup` and spends nothing, the way `network_stats` is
//     skipped below Growth.
//
// The helpers `capture-jobs.ts` does not export (num/text, dedupe, upsert,
// newestAt, guardJob, failed) are copied here from `capture-categories.ts`
// rather than changing that module: other capture lanes are being added
// concurrently against it.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { CMC_DEX_NETWORKS, cmcDexIdentity, cmcDexNumber } from '../market-assets/cmc-dex.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, hourBucket, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'

/** The provider's own stage names, kept verbatim so a stored row and a
 * `discoveryStage` on a live response are the same string. */
export const MEME_STAGES = ['newCreations', 'aboutGraduates', 'graduates'] as const
export type MemeStage = typeof MEME_STAGES[number]
/** Furthest stage wins when one response names a contract twice. */
const STAGE_RANK: Record<string, number> = { newCreations: 1, aboutGraduates: 2, graduates: 3 }

/** Probe order. Solana first: the launchpads this lane is about live there. */
export const MEME_PLATFORM_ORDER = ['solana', 'base', 'ethereum', 'arbitrum'] as const
/** The provider's ceiling for a discovery page. */
export const MEME_PAGE_SIZE = 25
/** One call per platform, so the per-run ceiling is the platform count. */
export const MEME_MAX_CALLS = MEME_PLATFORM_ORDER.length
/** Previous-snapshot read ceiling per platform. Three stage arrays of 25 is at
 * most 75 contracts, so 2,000 rows is more than a full day of hourly history
 * for every one of them. */
export const MEME_PRIOR_ROWS = 2000

const CADENCE_GRACE = 0.9
const MAX_UPSERT_ROWS = 500
/** Cadence a lane falls back to when its `provider_schedule_policy` row is
 * missing. `schedulePolicy` defaults an unknown feature to one hour, which is
 * also this lane's designed cadence — it is restated so a later change to that
 * default cannot silently change this lane's credit line. */
const LANE_CADENCE: Record<string, number> = { meme_stages: 3600 }

function lanePolicy(deps: CaptureDeps, feature: string): { enabled: boolean; cadenceSeconds: number } {
  const row = (deps.policy || []).find((r) => r?.feature === feature && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  if (!row) return { enabled: true, cadenceSeconds: LANE_CADENCE[feature] ?? 3600 }
  const policy = schedulePolicy(deps.policy, feature)
  return { enabled: policy.enabled, cadenceSeconds: policy.cadenceSeconds }
}

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
  freshness: { table: string; column: string }): Promise<JobResult | null> {
  const policy = lanePolicy(deps, feature)
  if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
  const newest = await newestAt(db, freshness.table, freshness.column)
  if (newest != null && now.getTime() - newest < policy.cadenceSeconds * 1000 * CADENCE_GRACE) {
    return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: new Date(newest).toISOString() }
  }
  return null
}

/** Primary keys reject a duplicate inside one statement, so a provider page that
 * repeats an identity is collapsed before the write. */
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

export interface MemeCandidate {
  chain: string; address: string; stage: MemeStage
  name: string | null; symbol: string | null; price: number | null; marketCap: number | null
}

/**
 * One `dexMeme` response → at most one candidate per contract, with the stage it
 * reached. A row whose canonical identity does not resolve to the platform the
 * request pinned is DROPPED, not repaired: the response would then be about a
 * different chain than the question.
 */
// deno-lint-ignore no-explicit-any
export function memeCandidates(payload: any, platformId: number): MemeCandidate[] {
  const byContract = new Map<string, MemeCandidate>()
  for (const row of cmcRows('dexMeme', payload).rows) {
    const stage = String(row?.discoveryStage || '')
    if (!MEME_STAGES.includes(stage as MemeStage)) continue
    const identity = cmcDexIdentity(row?.canonicalKey)
    if (!identity || identity.platformId !== platformId) continue
    const candidate: MemeCandidate = {
      chain: identity.chain, address: identity.address, stage: stage as MemeStage,
      name: text(row?.name, 200), symbol: text(row?.symbol, 50),
      price: cmcDexNumber(row?.quote?.price), marketCap: cmcDexNumber(row?.mcap),
    }
    const previous = byContract.get(identity.subject)
    if (!previous || STAGE_RANK[candidate.stage] > STAGE_RANK[previous.stage]) byContract.set(identity.subject, candidate)
  }
  return [...byContract.values()]
}

interface Prior { stage: string | null; firstSeenAt: string | null }

/** Newest snapshot STRICTLY BEFORE this capture, per contract. `lt` on
 * `captured_at` is what makes re-running the same hour idempotent: the rows this
 * run already wrote are never read back as their own predecessor. */
// deno-lint-ignore no-explicit-any
async function priorSnapshots(db: any, chain: string, addresses: string[], capturedAt: string): Promise<{ byAddress: Map<string, Prior>; truncated: boolean; reason: string | null }> {
  const byAddress = new Map<string, Prior>()
  if (!addresses.length) return { byAddress, truncated: false, reason: null }
  try {
    const { data, error } = await db.from('intel_meme_stage_snapshots')
      .select('contract_address,captured_at,stage,first_seen_at')
      .eq('chain', chain).in('contract_address', addresses).lt('captured_at', capturedAt)
      .order('captured_at', { ascending: false }).limit(MEME_PRIOR_ROWS)
    if (error) return { byAddress, truncated: false, reason: String(error.message || error).slice(0, 200) }
    const rows = Array.isArray(data) ? data : data ? [data] : []
    for (const row of rows) {
      const address = text(row?.contract_address, 200)
      // Rows arrive newest first, so the first sighting of an address IS its
      // newest snapshot, and that row already carries the carried-forward
      // first_seen_at. No second read is needed.
      if (!address || byAddress.has(address)) continue
      byAddress.set(address, { stage: text(row?.stage, 40), firstSeenAt: text(row?.first_seen_at, 40) })
    }
    return { byAddress, truncated: rows.length >= MEME_PRIOR_ROWS, reason: null }
  } catch (e) { return { byAddress, truncated: false, reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Hours between two ISO stamps, or null when either is unreadable. */
export function hoursBetween(from: string | null, to: string | null): number | null {
  const a = Date.parse(String(from ?? '')), b = Date.parse(String(to ?? ''))
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round(((b - a) / 3_600_000) * 1000) / 1000
}

/**
 * Hourly meme-stage capture across the verified CMC DEX platforms.
 */
// deno-lint-ignore no-explicit-any
export async function captureMemeStages(db: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now = new Date(), plan = 'basic', deps: CaptureDeps): Promise<JobResult> {
  const job = 'meme_stages'
  let credits = 0
  try {
    if (!planAllows(plan, 'startup')) return { job, rows: 0, credits: 0, skipped: 'plan_below_startup' }
    const skip = await guardJob(db, job, 'meme_stages', deps, now, { table: 'intel_meme_stage_snapshots', column: 'captured_at' })
    if (skip) return skip
    const ctx = ctxFor('meme-stages', MEME_MAX_CALLS)
    const budget = callBudget(ctx, MEME_MAX_CALLS)
    if (budget < 1) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    const capturedAt = hourBucket(now)
    const snapshots: Record<string, unknown>[] = []
    const transitions: Record<string, unknown>[] = []
    const platforms: Record<string, unknown>[] = []
    let requested = 0, priorTruncated = false, reason: string | null = null

    for (const platform of MEME_PLATFORM_ORDER) {
      const network = CMC_DEX_NETWORKS.find((n) => n.platform === platform)
      if (!network) continue
      if (requested >= budget) { platforms.push({ platform, platformId: null, state: 'skipped', reason: 'call_budget', rows: 0 }); continue }
      requested += 1
      const params = { platformIds: String(network.platformId), interval: '24h', pageSize: MEME_PAGE_SIZE }
      credits += estimateCmcCredits('dexMeme', { platformIds: String(network.platformId), pageSize: String(MEME_PAGE_SIZE) })
      const result = await deps.request('dexMeme', params, ctx).catch(() => null)
      if (!result?.payload) {
        reason = reason || result?.reason || 'provider_unavailable'
        platforms.push({ platform, platformId: network.platformId, state: 'unavailable', reason: result?.reason || 'provider_unavailable', rows: 0 })
        continue
      }
      let candidates: MemeCandidate[] = []
      try { candidates = memeCandidates(result.payload, network.platformId) } catch (e) {
        platforms.push({ platform, platformId: network.platformId, state: 'unreadable', reason: ((e as Error)?.message || 'invalid_response').slice(0, 120), rows: 0 })
        continue
      }
      if (!candidates.length) { platforms.push({ platform, platformId: network.platformId, state: 'empty', reason: null, rows: 0 }); continue }
      const prior = await priorSnapshots(db, network.chain, candidates.map((c) => c.address), capturedAt)
      priorTruncated = priorTruncated || prior.truncated
      reason = reason || prior.reason
      let moved = 0
      for (const candidate of candidates) {
        const previous = prior.byAddress.get(candidate.address)
        const firstSeenAt = previous?.firstSeenAt || capturedAt
        snapshots.push({
          platform_id: network.platformId, chain: candidate.chain, contract_address: candidate.address,
          captured_at: capturedAt, stage: candidate.stage,
          name: candidate.name, symbol: candidate.symbol,
          price: candidate.price, market_cap: candidate.marketCap,
          first_seen_at: firstSeenAt,
        })
        // No previous snapshot is not a transition: there is no stage to move from.
        if (previous?.stage && previous.stage !== candidate.stage) {
          moved += 1
          transitions.push({
            chain: candidate.chain, contract_address: candidate.address,
            from_stage: previous.stage, to_stage: candidate.stage, at: capturedAt,
            hours_since_first_seen: hoursBetween(firstSeenAt, capturedAt),
          })
        }
      }
      platforms.push({ platform, platformId: network.platformId, state: 'captured', reason: null, rows: candidates.length, transitions: moved })
    }

    if (!snapshots.length) return { job, rows: 0, credits, capturedAt, platforms, ...(reason ? { error: reason } : { skipped: 'no_reported_contracts' }) }
    const wroteSnapshots = await upsert(db, 'intel_meme_stage_snapshots',
      dedupe(snapshots, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,captured_at')
    const wroteTransitions = transitions.length
      ? await upsert(db, 'intel_meme_stage_transitions', dedupe(transitions, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,at')
      : { rows: 0 }
    const error = wroteSnapshots.error || wroteTransitions.error || null
    return {
      job, rows: wroteSnapshots.rows, credits, capturedAt, platforms,
      transitions: wroteTransitions.rows, contracts: snapshots.length,
      ...(priorTruncated ? { priorTruncated: true } : {}),
      ...(reason ? { partial: reason } : {}), ...(error ? { error } : {}),
    }
  } catch (e) { return failed(job, credits, e) }
}

/** Integration surface. The `intel-capture` Edge Function maps an op name onto
 * one of these; the reviewer wires them in alongside the other lanes. */
export const MEME_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps
) => Promise<JobResult>> = {
  meme_stages: (admin, ctxFor, now, plan, deps) => captureMemeStages(admin, ctxFor, now, plan, deps),
}
