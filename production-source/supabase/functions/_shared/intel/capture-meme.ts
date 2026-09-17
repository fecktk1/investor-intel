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
//   ONE `dexMeme` call PER LAUNCHPAD PROTOCOL — two today (Pump.fun and
//   Moonshot), so 2 credits, 48 a day, ~1,440 a month against the scaled
//   `attention` feature cap. The shared transport serves a still-fresh snapshot
//   for 0 credits, so the billed total is never higher.
//
//   CORRECTED 2026-09-15. This lane used to make one call PER PLATFORM, sending
//   {platformIds, interval, pageSize}. Four calls asked the same question, and
//   because the documented page field `limit` was missing the provider answered
//   200, error_code 0, 1 credit and three EMPTY arrays to each of them (40 calls,
//   252 bytes each, 2026-09-15 03:57-12:37 UTC; zero rows stored).
//
//   CORRECTED AGAIN 2026-09-17. The 2026-09-15 rewrite also DROPPED
//   `platformIds`, on the reading that the published request schema does not list
//   it. From the first run of that body (2026-09-15 13:37 UTC, minutes after the
//   release deploy) the provider refused every call: HTTP 403, no credit, 48 runs
//   and counting, while every other DEX endpoint on the same key and the same
//   Startup plan still answers 200. So the request carries `platformIds` again
//   NEXT TO `limit` — the pair the provider's own published example uses — and
//   the answer is still SPLIT by platform ourselves: every row names its own
//   `pid`, and a row whose platform is not one of the four verified CMC DEX
//   networks is DROPPED, never repaired. The request field is a question, not an
//   identity; only `pid` decides which chain a row belongs to.
//
//   The response still carries three arrays: `newCreations`, `aboutGraduates`,
//   `graduates`.
//
//   A refused request is not asked again every hour: the transport keeps an
//   entitlement refusal in its negative cache (keyed by the exact params) for six
//   hours, so a refusal costs nothing until it is re-tested, and a CORRECTED
//   request is tried at the very next run.
//
//   CORRECTED A THIRD TIME 2026-09-17, after the deploy of the above (v18). With
//   `platformIds` restored the provider answered 200 and 1 credit again — and
//   three EMPTY arrays again, the same 252-byte answer as every call before the
//   403 streak. The one documented field never sent was `protocol`, the LAUNCHPAD
//   code, and the published response carries it as `pt`: 1001 Pump.fun, 1002
//   Moonshot, 2001 Four.meme. The board is therefore read per launchpad: one call
//   for each protocol that lives on a verified CMC DEX network, merged by
//   contract with the furthest stage winning, each one its own cache key so each
//   is tried fresh and each answer is reported on its own line. 2001 Four.meme is
//   NOT asked: it launches on BNB Chain, which this platform does not verify.
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
//   * An EMPTY answer is a result, not a no-op. There is no contract-less row to
//     write — the snapshot table is keyed (chain, contract_address, captured_at)
//     — so the honest empty capture is the reasoned JobResult plus ONE info line
//     per run (`intel_meme_capture`) carrying {platform, stage, rows, reason} for
//     every platform and stage, zeros included. The next run is then diagnosable
//     from the function log alone, which is exactly what the first thirty-six
//     silent runs were not.
//
// The helpers `capture-jobs.ts` does not export (num/text, dedupe, upsert,
// newestAt, guardJob, failed) are copied here from `capture-categories.ts`
// rather than changing that module: other capture lanes are being added
// concurrently against it.

import { cmcRows, planAllows, estimateCmcCredits } from '../market-assets/cmc-capabilities.ts'
import { CMC_DEX_NETWORKS, CMC_DEX_MEME_LIMIT, CMC_DEX_MEME_PLATFORM_ID, cmcDexRowIdentity, cmcDexNumber } from '../market-assets/cmc-dex.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { CAPTURE_PROVIDER, hourBucket, schedulePolicy } from './capture-jobs.ts'
import type { CaptureDeps, JobResult } from './capture-jobs.ts'

/** The provider's own stage names, kept verbatim so a stored row and a
 * `discoveryStage` on a live response are the same string. */
export const MEME_STAGES = ['newCreations', 'aboutGraduates', 'graduates'] as const
export type MemeStage = typeof MEME_STAGES[number]
/** Furthest stage wins when one response names a contract twice. */
const STAGE_RANK: Record<string, number> = { newCreations: 1, aboutGraduates: 2, graduates: 3 }

/** Reporting order of the platforms we can recognise in the answer. It is no
 * longer a PROBE order: one call a run answers for all of them, and the rows are
 * attributed by the `pid` each names. Solana leads because that is where the
 * launchpads live, and it is also the platform the request itself names. */
export const MEME_PLATFORM_ORDER = ['solana', 'base', 'ethereum', 'arbitrum'] as const
/** Rows requested per stage array. The documented request field is `limit`. */
export const MEME_LIMIT = CMC_DEX_MEME_LIMIT
/** The verified CMC DEX network the request names by default. A REQUEST field
 * only: what a row belongs to is decided by the row's own `pid`, never by this. */
export const MEME_PLATFORM_ID = CMC_DEX_MEME_PLATFORM_ID
/**
 * The launchpads this lane asks about, one call each.
 *
 * `protocol` is the provider's own launchpad code, published as the response
 * field `pt` (1001 Pump.fun, 1002 Moonshot, 2001 Four.meme). Nothing here is
 * guessed: a protocol is asked for only when the provider publishes its code AND
 * the chain it launches on is a verified CMC DEX network.
 *
 * FOUR.MEME (2001) IS DELIBERATELY ABSENT. It launches on BNB Chain, which is not
 * in `CMC_DEX_NETWORKS`, so its rows could not be given an identity even if they
 * were returned. Adding it is the same work as adding the chain (proposal 31).
 *
 * `launchpad` is OUR stable key for the run result and the log line; the label is
 * the provider's own name for the launchpad and is never shown as a chain.
 */
export const MEME_PROTOCOLS = [
  { protocol: 1001, launchpad: 'pump_fun', label: 'Pump.fun', platformId: CMC_DEX_MEME_PLATFORM_ID },
  { protocol: 1002, launchpad: 'moonshot', label: 'Moonshot', platformId: CMC_DEX_MEME_PLATFORM_ID },
] as const
/** One call per launchpad protocol, and never more than the lane asks for. */
export const MEME_MAX_CALLS = MEME_PROTOCOLS.length
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
  platform: string; platformId: number; chain: string; address: string; stage: MemeStage
  name: string | null; symbol: string | null; price: number | null; marketCap: number | null
}

/**
 * One `dexMeme` response → at most one candidate per contract, with the stage it
 * reached and the platform the ROW named.
 *
 * The endpoint takes no platform filter, so the answer legitimately spans chains
 * this platform has no verified CMC DEX evidence for. Such a row is DROPPED —
 * `cmcDexRowIdentity` (the one pid → registry mapping, shared with the discovery
 * cohort path) resolves only the four verified networks — never repaired into an
 * identity and never attributed to a chain it did not name. `dropped` counts the
 * rows that fell out this way so a run can say so instead of looking empty.
 */
// deno-lint-ignore no-explicit-any
export function memeCandidates(payload: any): { candidates: MemeCandidate[]; dropped: number } {
  const byContract = new Map<string, MemeCandidate>()
  let dropped = 0
  for (const row of cmcRows('dexMeme', payload, { limit: String(MEME_LIMIT) }).rows) {
    const stage = String(row?.discoveryStage || '')
    if (!MEME_STAGES.includes(stage as MemeStage)) { dropped += 1; continue }
    // No pin: this lane keeps every verified platform and splits them afterwards.
    const identity = cmcDexRowIdentity(row?.canonicalKey, null)
    if (!identity) { dropped += 1; continue }
    const candidate: MemeCandidate = {
      platform: identity.platform, platformId: identity.platformId,
      chain: identity.chain, address: identity.address, stage: stage as MemeStage,
      name: text(row?.name, 200), symbol: text(row?.symbol, 50),
      price: cmcDexNumber(row?.quote?.price), marketCap: cmcDexNumber(row?.mcap),
    }
    const previous = byContract.get(identity.subject)
    if (!previous || STAGE_RANK[candidate.stage] > STAGE_RANK[previous.stage]) byContract.set(identity.subject, candidate)
  }
  return { candidates: [...byContract.values()], dropped }
}

export interface MemeStageLine { platform: string; stage: MemeStage; rows: number; reason: string | null }
/** One asked launchpad, and what it answered. `rows` is the contracts THIS call
 * contributed before the merge across protocols, so a still-empty board says
 * which launchpad was asked rather than looking like one silent lane. */
export interface MemeProtocolLine {
  protocol: number; launchpad: string; label: string; platformId: number
  state: string; reason: string | null; rows: number; dropped: number
}

/** Every platform × every stage, zeros included. A stage that answered nothing
 * has to appear as a zero with a reason; an absent line would be indistinguishable
 * from a lane that never ran, which is precisely how this lane failed silently. */
export function stageBreakdown(candidates: MemeCandidate[], reason: string | null): MemeStageLine[] {
  const lines: MemeStageLine[] = []
  for (const platform of MEME_PLATFORM_ORDER) {
    for (const stage of MEME_STAGES) {
      const rows = candidates.filter((c) => c.platform === platform && c.stage === stage).length
      lines.push({ platform, stage, rows, reason: rows ? null : reason })
    }
  }
  return lines
}

/** ONE info line a run. Everything needed to diagnose the next run — the call
 * state, the reason, the rows per platform and stage — is on this single line,
 * so no follow-up query is needed to tell "nothing was there" from "we asked the
 * wrong question". Never logs a request parameter that could carry a secret; the
 * API key travels in a transport header this module never sees. */
function logCapture(entry: {
  capturedAt: string; calls: number; credits: number; state: string
  reason: string | null; dropped: number; stages: MemeStageLine[]; protocols: MemeProtocolLine[]
}): void {
  try {
    console.info(JSON.stringify({
      intel_meme_capture: {
        lane: 'meme_stages', capability: 'dexMeme', limit: MEME_LIMIT, platformIds: String(MEME_PLATFORM_ID),
        capturedAt: entry.capturedAt, calls: entry.calls, credits: entry.credits,
        state: entry.state, reason: entry.reason ?? null, droppedRows: entry.dropped,
        rows: entry.stages.reduce((sum, line) => sum + line.rows, 0),
        // The asked launchpads come FIRST on the line: an empty board is only
        // diagnosable if the question is on the same line as the answer.
        protocols: entry.protocols,
        stages: entry.stages,
      },
    }))
  } catch { /* a log must never fail a capture */ }
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
    let priorTruncated = false, reason: string | null = null, dropped = 0

    // ── ONE call per launchpad protocol. The board is published per launchpad:
    // asking without `protocol` answered 200, 1 credit and three empty arrays,
    // both before and after the platform filter was restored. Each protocol is
    // its own request, so each has its own cache key and is tried fresh. ──
    const byContract = new Map<string, MemeCandidate>()
    const protocols: MemeProtocolLine[] = []
    let requested = 0
    for (const launchpad of MEME_PROTOCOLS) {
      const line: MemeProtocolLine = {
        protocol: launchpad.protocol, launchpad: launchpad.launchpad, label: launchpad.label, platformId: launchpad.platformId,
        state: 'skipped', reason: 'call_budget', rows: 0, dropped: 0,
      }
      protocols.push(line)
      // The ceiling is the lane's, not the loop's: a narrowed context stops the
      // run where it is instead of asking one launchpad more than it may.
      if (requested >= budget) continue
      requested += 1
      const params = { platformIds: String(launchpad.platformId), protocol: launchpad.protocol, limit: MEME_LIMIT }
      const result = await deps.request('dexMeme', params, ctx).catch(() => null)
      // A snapshot or a remembered refusal answered without asking the provider,
      // so it costs nothing: only a live call carries the estimate onto the result.
      const origin = (result as { receipt?: { origin?: string } } | null)?.receipt?.origin
      if (origin !== 'cache' && origin !== 'negative-cache') {
        credits += estimateCmcCredits('dexMeme', { platformIds: String(launchpad.platformId), protocol: String(launchpad.protocol), limit: String(MEME_LIMIT) })
      }
      if (!result?.payload) {
        line.state = 'unavailable'
        line.reason = result?.reason || 'provider_unavailable'
        reason = reason || line.reason
        continue
      }
      try {
        const read = memeCandidates(result.payload)
        dropped += read.dropped
        line.dropped = read.dropped
        line.rows = read.candidates.length
        line.state = read.candidates.length ? 'captured' : 'empty'
        // An empty board is an answer, and it is reported as one. `dropped` says
        // whether the board was genuinely empty or only empty of chains we verify.
        line.reason = read.candidates.length ? null : (read.dropped ? 'unverified_platforms_only' : 'provider_reported_empty')
        // Merge across launchpads by contract: two launchpads can name the same
        // contract, and the FURTHEST stage wins, exactly as inside one answer.
        for (const candidate of read.candidates) {
          const subject = `${candidate.chain}:${candidate.address}`
          const previous = byContract.get(subject)
          if (!previous || STAGE_RANK[candidate.stage] > STAGE_RANK[previous.stage]) byContract.set(subject, candidate)
        }
      } catch (e) {
        line.state = 'unreadable'
        line.reason = ((e as Error)?.message || 'invalid_response').slice(0, 120)
        reason = reason || line.reason
      }
    }
    const candidates = [...byContract.values()]
    // The run's own state is the state of the launchpads it asked, never of one
    // of them: rows anywhere is a capture, and an empty board stays an empty
    // board rather than being reported as a provider failure.
    const answered = protocols.filter((p) => p.state === 'empty' || p.state === 'captured')
    const callState = candidates.length
      ? 'captured'
      : answered.length
        ? 'empty'
        : protocols.some((p) => p.state === 'unreadable')
          ? 'unreadable'
          : protocols.some((p) => p.state === 'unavailable') ? 'unavailable' : 'skipped'
    const callReason: string | null = candidates.length
      ? null
      : (protocols.find((p) => p.state === callState)?.reason ?? (callState === 'skipped' ? 'call_budget' : null))

    // ── split the one answer by the platform each ROW named ──
    for (const platform of MEME_PLATFORM_ORDER) {
      const network = CMC_DEX_NETWORKS.find((n) => n.platform === platform)
      if (!network) continue
      const mine = candidates.filter((c) => c.platformId === network.platformId)
      if (!mine.length) {
        platforms.push({ platform, platformId: network.platformId, state: callState === 'captured' ? 'empty' : callState, reason: callReason, rows: 0 })
        continue
      }
      const prior = await priorSnapshots(db, network.chain, mine.map((c) => c.address), capturedAt)
      priorTruncated = priorTruncated || prior.truncated
      reason = reason || prior.reason
      let moved = 0
      for (const candidate of mine) {
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
      platforms.push({ platform, platformId: network.platformId, state: 'captured', reason: prior.reason, rows: mine.length, transitions: moved })
    }

    const stages = stageBreakdown(candidates, callReason)
    logCapture({ capturedAt, calls: requested, credits, state: callState, reason: callReason ?? reason, dropped, stages, protocols })

    if (!snapshots.length) {
      // An honest empty capture: the reason travels on the result and on the log
      // line above. Nothing is written, because there is no contract-less row the
      // snapshot table could hold — and a zero is never invented to fill the gap.
      return {
        job, rows: 0, credits, capturedAt, calls: requested, protocols, platforms, stages, dropped,
        ...(callState === 'unavailable' || callState === 'unreadable'
          ? { error: callReason ?? 'provider_unavailable' }
          : { skipped: callReason ?? 'no_reported_contracts' }),
      }
    }
    const wroteSnapshots = await upsert(db, 'intel_meme_stage_snapshots',
      dedupe(snapshots, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,captured_at')
    const wroteTransitions = transitions.length
      ? await upsert(db, 'intel_meme_stage_transitions', dedupe(transitions, (r) => `${r.chain}|${r.contract_address}`), 'chain,contract_address,at')
      : { rows: 0 }
    const error = wroteSnapshots.error || wroteTransitions.error || null
    return {
      job, rows: wroteSnapshots.rows, credits, capturedAt, calls: requested, protocols, platforms, stages, dropped,
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
