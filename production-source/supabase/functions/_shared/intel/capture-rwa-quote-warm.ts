// Investor Intel: the RWA judge-path WARM lane.
//
// Same contract as the other capture lanes (`capture-rwa-wrappers.ts`,
// `capture-rwa-coverage.ts`): one bounded function with an explicit call and
// credit ceiling, obeying `provider_schedule_policy`, never throwing (a failure
// becomes `{ error }`), and reaching CoinMarketCap only through the injected
// transport so it tests without a network or a database.
//
// THE QUESTION. The public tokenised-asset lookup and the /intel/rwa workspace
// (for members, and for /intel/demo visitors through intel-rwa-lookup) read two
// SHARED cache entries far more than any other: the first page of the asset list
// and the latest quote of the assets a visitor is steered to (the three lookup
// examples, the rows of that first page, and every asset on the wrapper board).
// Left to readers, those entries sit past their one-hour window until somebody's
// read happens to refresh them, and the first reader of the hour pays the wait.
// This lane keeps exactly those entries inside their window, for everybody.
//
// WHAT ONE RUN DOES, AND WHAT IT COSTS.
//   1. Zero-credit reads: this lane's own newest run row (is anything due?), the
//      two warmed entries in the shared cache (cache only, maxCalls 0), the three
//      example tickers in the stored RWA catalogue, and the newest wrapper board.
//   2. `/v5/real-world-assets/assets/list?start=1&limit=25`, the first page
//      exactly as the workspace asks for it, so the page reads THIS entry.
//      ceil(25/250) = 1 credit, and only when that entry is past its window.
//   3. `/v5/real-world-assets/quotes/latest` ONCE for every asset above, comma
//      joined (at most WARM_BATCH_CAP = 100 ids): ceil(n/250) = 1 credit, and only
//      when that entry is past its window. Readers are served from this one
//      batched entry with a receipt that names the batched request (rwa-lookup.ts).
//   Upper bound: 2 calls and 2 credits per run. A warmed entry lasts its TTL (one
//   hour), and the shared reservation refuses to refill an entry still inside it
//   ('cache_ready'), so a run lands once per hour plus the minute it waits for
//   pg_cron: about 24 runs and 47 CREDITS A DAY.
//
// WHOSE BUDGET. Every call here first claims its credit from the SAME daily
// platform-wide free RWA budget the lookup's own live reads use
// (intel_free_rwa_read_claim, cap in cmc_free_rwa_policy, 200 a day). The free
// path therefore still spends at most 200 credits a day however it is split, the
// warm lane stops when that day is spent, and visitors keep what it leaves.
//
// WHEN IT RUNS. pg_cron ticks every minute, but the tick only POSTs to this
// function when public.intel_rwa_quote_warm_due() says a warmed entry has reached
// the end of its window (next_due_at on the newest run row), so the function runs
// about once an hour, and an entry is past its window for at most about a minute.
// It cannot refresh AHEAD of expiry: cmc_request_reserve refuses a key whose
// copy is still inside its TTL, which is the guard against paying twice.
//
// WHEN THE PLAN REFUSES. A plan refusal (HTTP 402/403, insufficient_entitlement),
// a key problem or a spent monthly quota STOPS the run at that call, and the run
// row pushes next_due_at six hours out, the same six hours the transport holds an
// entitlement refusal. The lookup reads the same row and makes no live read of its
// own while that refusal stands, so after the plan changes nobody keeps paying to
// be told no; every reader keeps the newest good copy with its age and reason.
// A spent free budget waits for the next UTC day; a transient failure retries in
// five minutes.

import { CAPTURE_PROVIDER, schedulePolicy, type CaptureDeps, type JobResult } from './capture-jobs.ts'
import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { claimFreeRwaRead, type FreeRwaClaim } from './rwa-free-read.ts'

export const RWA_QUOTE_WARM_FEATURE = 'rwa_quote_warm'
export const WARM_RUN_TABLE = 'intel_rwa_quote_warm_runs'

/** The pg_cron job, from migration 20260923160000_intel_rwa_quote_warm.sql.
 * Asserted against the migration by test. */
export const RWA_QUOTE_WARM_SCHEDULE = {
  rwa_quote_warm: { job: 'intel-capture-rwa-quote-warm', cron: '* * * * *', cadence: 'when_due', utc: 'checked every minute; runs when a warmed entry reaches the end of its window' },
} as const

/** The first page of /intel/rwa exactly as MarketResearchPage.jsx asks for it
 * (start 1, limit 25, no asset type). cmcParams canonicalises the params the
 * shared cache key is hashed from, so the page's read lands on this entry. */
export const WARM_LIST_PARAMS: Readonly<Record<string, number>> = Object.freeze({ start: 1, limit: 25 })
/** The lookup's example tickers (RWA_LOOKUP_EXAMPLES in src/intel/lib/rwa-lookup-api.js). */
export const WARM_EXAMPLE_SYMBOLS = ['NVDA', 'SGOV', 'GOLD'] as const
/** rwa_ids in the one batched quotes read. ceil(100/250) = 1 credit. */
export const WARM_BATCH_CAP = 100
/** Per-run credit ceiling when the policy row carries no `max_credits`. */
export const WARM_CREDIT_CEILING = 2
/** Refusals that mean the provider will keep saying no: stop, and back off. */
export const WARM_STOP_REASONS: ReadonlySet<string> = new Set(['insufficient_entitlement', 'credential_unavailable', 'quota_exhausted'])
export const WARM_PLAN_BACKOFF_MS = 6 * 3_600_000
export const WARM_RETRY_MS = 5 * 60_000
export const WARM_DISABLED_BACKOFF_MS = 3_600_000
/** A run never schedules its successor sooner than this. */
export const WARM_MIN_GAP_MS = 60_000
export const WARM_RETENTION_DAYS = 14

const RWA_ID = /^[1-9][0-9]{0,11}$/
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const isoOf = (v: unknown): string | null => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? new Date(t).toISOString() : null }
const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

// deno-lint-ignore no-explicit-any
type Db = any
// deno-lint-ignore no-explicit-any
type Result = Record<string, any> | null

export interface WarmDeps extends CaptureDeps {
  /** Claim one live read from the daily free RWA budget (claimFreeRwaRead). */
  claim: (capability: string, params: Record<string, string>) => Promise<FreeRwaClaim>
}

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

export function lanePolicy(deps: CaptureDeps): { enabled: boolean; maxCredits: number } {
  const row = (deps.policy || []).find((r) => r?.feature === RWA_QUOTE_WARM_FEATURE && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  // No row is not a licence: this lane spends a free budget, so it runs only
  // when its policy row exists and is enabled (the migration inserts it).
  if (!row) return { enabled: false, maxCredits: 0 }
  const ceiling = Number(row.max_credits)
  return {
    enabled: schedulePolicy(deps.policy, RWA_QUOTE_WARM_FEATURE).enabled,
    maxCredits: Number.isFinite(ceiling) && ceiling >= 0 ? Math.min(WARM_CREDIT_CEILING, Math.trunc(ceiling)) : WARM_CREDIT_CEILING,
  }
}

/** Inside its refresh window: a live answer, or a cache row before expires_at. */
const inWindow = (r: Result) => !!r && (r.state === 'fresh' || r.state === 'cached')
const expiresOf = (r: Result): string | null => isoOf(r?.provenance?.expiresAt)
const fetchedOf = (r: Result): string | null => isoOf(r?.provenance?.fetchedAt ?? r?.receipt?.fetchedAt)

/** The assets the batched read carries, in priority order before the cap: the
 * lookup examples, the first list page, then the wrapper board. Every read is a
 * database read. Sorted numerically at the end, because the transport sorts an
 * rwa_id list into its canonical cache key anyway. */
export function warmIdSet(input: { examples: string[]; listIds: string[]; wrapperIds: string[] }, cap = WARM_BATCH_CAP): string[] {
  const out: string[] = []
  for (const id of [...input.examples, ...input.listIds, ...input.wrapperIds]) {
    const s = String(id ?? '')
    if (RWA_ID.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= cap) break
  }
  return out.sort((a, b) => Number(a) - Number(b))
}

/** The example tickers as the lookup resolves them: exact ticker, best rank. */
// deno-lint-ignore no-explicit-any
export function exampleIds(rows: any[]): string[] {
  const best = new Map<string, { id: string; rank: number }>()
  for (const row of rows) {
    const symbol = text(row?.symbol, 40)?.toUpperCase()
    const id = String(row?.rwa_id ?? '')
    if (!symbol || !RWA_ID.test(id) || !(WARM_EXAMPLE_SYMBOLS as readonly string[]).includes(symbol)) continue
    const rank = num(row?.rwa_rank) ?? Number.MAX_SAFE_INTEGER
    const seen = best.get(symbol)
    if (!seen || rank < seen.rank || (rank === seen.rank && Number(id) < Number(seen.id))) best.set(symbol, { id, rank })
  }
  return WARM_EXAMPLE_SYMBOLS.map((s) => best.get(s)?.id).filter((v): v is string => !!v)
}

/** The newest finished run: which batched entry readers should consult, and
 * whether a refusal it recorded still stands. Read by intel-rwa-lookup. Never
 * throws: no row, or an unreadable one, is simply "no warm state". */
export interface WarmState { batchIds: string | null; batchSize: number; stopReason: string | null; nextDueAt: string | null; finishedAt: string | null }
export async function loadWarmState(db: Db): Promise<WarmState | null> {
  const read = await readRows(() => db.from(WARM_RUN_TABLE).select('batch_ids,batch_size,stop_reason,next_due_at,finished_at')
    .eq('state', 'done').order('ran_at', { ascending: false }).limit(1))
  const row = read.rows[0]
  if (!row) return null
  const ids = typeof row.batch_ids === 'string' && /^[1-9][0-9]{0,11}(,[1-9][0-9]{0,11}){0,249}$/.test(row.batch_ids) ? row.batch_ids : null
  return { batchIds: ids, batchSize: ids ? ids.split(',').length : 0, stopReason: text(row.stop_reason, 80), nextDueAt: isoOf(row.next_due_at), finishedAt: isoOf(row.finished_at) }
}

/** The refusal a reader should honour instead of asking the provider itself:
 * only a STOP reason, and only while its backoff has not run out. */
export function warmPlanRefusal(state: WarmState | null, now: number): string | null {
  if (!state?.stopReason || !WARM_STOP_REASONS.has(state.stopReason)) return null
  const until = Date.parse(String(state.nextDueAt ?? ''))
  return Number.isFinite(until) && until > now ? state.stopReason : null
}

/** When the next run is due, from what this run found. */
export function nextDue(input: { now: number; stopReason: string | null; transient: boolean; expiries: (string | null)[] }): string {
  const { now } = input
  const at = (ms: number) => new Date(ms).toISOString()
  if (input.stopReason && WARM_STOP_REASONS.has(input.stopReason)) return at(now + WARM_PLAN_BACKOFF_MS)
  if (input.stopReason === 'free_rwa_budget_exhausted') {
    const d = new Date(now)
    return at(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 1))
  }
  if (input.stopReason) return at(now + WARM_DISABLED_BACKOFF_MS)
  if (input.transient) return at(now + WARM_RETRY_MS)
  const times = input.expiries.map((v) => Date.parse(String(v ?? ''))).filter(Number.isFinite)
  if (times.length < input.expiries.length || !times.length) return at(now + WARM_RETRY_MS)
  return at(Math.max(now + WARM_MIN_GAP_MS, Math.min(...times)))
}

interface Entry {
  capability: string; ids?: number
  before: { state: string | null; fetchedAt: string | null; expiresAt: string | null }
  after: { state: string | null; fetchedAt: string | null; expiresAt: string | null } | null
  called: boolean; httpStatus: number | null; creditCount: number | null; reason: string | null
}
const view = (r: Result) => ({ state: text(r?.state, 20), fetchedAt: fetchedOf(r), expiresAt: expiresOf(r) })

export async function captureRwaQuoteWarm(
  admin: Db,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  deps: WarmDeps,
  body: Record<string, unknown> = {},
): Promise<JobResult> {
  const job = 'rwa_quote_warm'
  const nowMs = now.getTime()
  // The run's own clock: the invocation time plus the real time since, so every
  // time this run writes is measured from the same origin.
  const startedReal = Date.now()
  const clock = () => nowMs + (Date.now() - startedReal)
  let credits = 0, calls = 0, claimed = 0
  let runId: number | string | null = null
  try {
    const policy = lanePolicy(deps)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }

    const previous = await readRows(() => admin.from(WARM_RUN_TABLE).select('id,ran_at,state,batch_ids,next_due_at')
      .order('ran_at', { ascending: false }).limit(1))
    const last = previous.rows[0] ?? null
    const dueAt = Date.parse(String(last?.next_due_at ?? ''))
    if (body?.force !== true && Number.isFinite(dueAt) && dueAt > nowMs) {
      return { job, rows: 0, credits: 0, skipped: 'not_due', nextDueAt: new Date(dueAt).toISOString() }
    }

    // A started row first, due again in five minutes: a run that dies half way
    // is retried then, and the minute tick does not start a second one meanwhile.
    try {
      const { data, error } = await admin.from(WARM_RUN_TABLE)
        .insert({ ran_at: now.toISOString(), state: 'running', next_due_at: new Date(nowMs + WARM_RETRY_MS).toISOString() }).select('id').single()
      if (error) return { job, rows: 0, credits: 0, error: `run_row_unavailable: ${String(error.message || error).slice(0, 120)}` }
      runId = data?.id ?? null
    } catch (e) { return { job, rows: 0, credits: 0, error: `run_row_unavailable: ${((e as Error)?.message || '').slice(0, 120)}` } }

    const cacheCtx: MarketAssetsContext = { supabase: admin, jobName: 'intel-capture', caller: 'intel-capture-rwa-quote-warm-cache', kind: 'render', maxCalls: 0, noDemand: true, selectedDemand: false }
    const liveCtx: MarketAssetsContext = { ...ctxFor('rwa-quote-warm', policy.maxCredits), noDemand: true, selectedDemand: false, waitForFresh: true }

    let stopReason: string | null = null
    let transient = false
    const entries: Entry[] = []
    const warm = async (capability: string, params: Record<string, string | number>, ids?: number): Promise<Result> => {
      const before = await deps.request(capability, params, cacheCtx).catch(() => null) as Result
      const entry: Entry = { capability, ...(ids ? { ids } : {}), before: view(before), after: null, called: false, httpStatus: null, creditCount: null, reason: null }
      entries.push(entry)
      if (inWindow(before)) { entry.after = entry.before; return before }
      if (stopReason) { entry.reason = stopReason; return before }
      if (calls >= policy.maxCredits) { entry.reason = 'call_budget'; transient = true; return before }
      const stringParams = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
      const grant = await deps.claim(capability, stringParams).catch(() => ({ allowed: false, reason: 'free_rwa_budget_unavailable', cap: null, used: null }))
      if (!grant.allowed) { stopReason = grant.reason || 'free_rwa_budget_unavailable'; entry.reason = stopReason; return before }
      claimed += 1
      const after = await deps.request(capability, params, liveCtx).catch(() => null) as Result
      const receipt = after?.receipt ?? null
      entry.after = view(after)
      entry.called = receipt?.origin === 'live'
      entry.httpStatus = num(receipt?.httpStatus)
      entry.creditCount = num(receipt?.creditCount)
      if (entry.called) { calls += 1; credits += entry.creditCount ?? 1 }
      if (!inWindow(after)) {
        const reason = text(after?.reason, 80) || 'provider_unavailable'
        entry.reason = reason
        // The plan (or the key, or the month) said no: stop here, spend nothing more.
        if (WARM_STOP_REASONS.has(reason) || [401, 402, 403].includes(entry.httpStatus ?? 0)) stopReason = WARM_STOP_REASONS.has(reason) ? reason : 'insufficient_entitlement'
        else transient = true
        return newest(after, before)
      }
      return after
    }

    // ── 1. The first page of the asset list.
    const list = await warm('rwaList', { ...WARM_LIST_PARAMS })

    // ── 2. Which assets the batched quote carries. Database reads only.
    const [profiles, wrappers] = await Promise.all([
      readRows(() => admin.from('intel_rwa_asset_profiles').select('rwa_id,symbol,rwa_rank').in('symbol', [...WARM_EXAMPLE_SYMBOLS]).limit(50)),
      readRows(() => admin.from('intel_rwa_wrapper_assets').select('rwa_id,captured_at').order('captured_at', { ascending: false }).limit(200)),
    ])
    const newestWrapper = wrappers.rows.map((r) => text(r?.captured_at, 40)).filter((v): v is string => !!v).sort().at(-1) ?? null
    const listIds = list?.payload ? cmcRows('rwaList', list.payload).rows.map((r) => String(r?.rwa_id ?? '')) : []
    let ids = warmIdSet({
      examples: exampleIds(profiles.rows),
      listIds,
      wrapperIds: wrappers.rows.filter((r) => text(r?.captured_at, 40) === newestWrapper).map((r) => String(r?.rwa_id ?? '')),
    })
    // Nothing could be read: keep warming the entry readers already consult.
    if (!ids.length && typeof last?.batch_ids === 'string') ids = last.batch_ids.split(',').filter((v: string) => RWA_ID.test(v))
    const partial = profiles.reason ? 'profiles_read_failed' : wrappers.reason ? 'wrapper_read_failed' : !listIds.length ? 'list_ids_unavailable' : null

    // ── 3. One batched quotes read for all of them.
    const batch = ids.length ? await warm('rwaQuotes', { rwa_id: ids.join(',') }, ids.length) : null

    const finished = new Date(clock())
    const next = nextDue({ now: finished.getTime(), stopReason, transient: transient || !ids.length, expiries: [expiresOf(list), ...(ids.length ? [expiresOf(batch)] : [])] })
    const record = {
      state: 'done', finished_at: finished.toISOString(),
      batch_ids: ids.length ? ids.join(',') : null, batch_size: ids.length,
      entries, calls, credits, claimed, stop_reason: stopReason, next_due_at: next,
      detail: { partial, listFetchedAt: fetchedOf(list), batchFetchedAt: fetchedOf(batch), maxCredits: policy.maxCredits },
    }
    let writeError: string | null = null
    try {
      const { error } = await admin.from(WARM_RUN_TABLE).update(record).eq('id', runId)
      if (error) writeError = String(error.message || error).slice(0, 160)
    } catch (e) { writeError = ((e as Error)?.message || 'write_failed').slice(0, 160) }
    // Bounded housekeeping: the run log keeps two weeks.
    try { await admin.from(WARM_RUN_TABLE).delete().lt('ran_at', new Date(nowMs - WARM_RETENTION_DAYS * 86_400_000).toISOString()) } catch { /* next run tries again */ }

    return {
      job, rows: entries.filter((e) => e.called && inWindow({ state: e.after?.state })).length, credits, calls, claimed,
      batchSize: ids.length, nextDueAt: next,
      list: entries[0] ?? null, batch: entries[1] ?? null,
      ...(stopReason ? { stopReason } : {}), ...(partial ? { partial } : {}),
      ...(writeError ? { error: `run_row_unwritten: ${writeError}` } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits, calls, error: ((e as Error)?.message || 'rwa_quote_warm_failed').slice(0, 200) }
  }
}

/** The newer of two usable results; a failed refresh keeps what it had. */
function newest(a: Result, b: Result): Result {
  const usable = (r: Result) => !!r && ['fresh', 'cached', 'stale'].includes(r.state) && r.payload != null
  if (!usable(a)) return usable(b) ? b : a
  if (!usable(b)) return a
  return (Date.parse(fetchedOf(a) ?? '') || 0) >= (Date.parse(fetchedOf(b) ?? '') || 0) ? a : b
}

/** Integration surface, wired in intel-capture/index.ts beside the other lanes.
 * The plan argument is ignored: rwaList and rwaQuotes are Basic-tier
 * capabilities, and a key that has lost them is told so by the provider (402),
 * which stops the run and backs it off (see the header). */
export const RWA_QUOTE_WARM_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  rwa_quote_warm: (admin, ctxFor, now, _plan, deps, body) => captureRwaQuoteWarm(admin, ctxFor, now, {
    ...deps,
    // The same daily free RWA budget the public lookup claims from.
    claim: (deps as Partial<WarmDeps>).claim ?? ((capability, params) => claimFreeRwaRead(admin, capability, params)),
  }, body ?? {}),
}
