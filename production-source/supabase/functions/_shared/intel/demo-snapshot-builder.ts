// Investor Intel public demo: the snapshot builder.
//
// WHAT IT DOES. Computes, on the server and in-process, the response bodies the
// real Investor Intel pages receive for a declared list of requests, scrubs
// them, and uploads each one to the public `intel-demo` bucket under the key the
// browser will derive for the same request (./demo-snapshot-key.ts). latest.json
// is written LAST, so a reader never sees a manifest naming a file that is not
// there yet.
//
// WHAT IT NEVER DOES.
//   * It never signs in as, or mints a session or token for, any user. There is
//     no member and no workspace: it reads with the service-role client it is
//     handed, through the same shared read code the Edge Functions use.
//   * It never calls a provider. Capture views are database reads
//     (./capture-read-envelope.ts). The free RWA research reads run the shared
//     cache pass ONLY (kind 'render', maxCalls 0, noDemand): nothing is spent now
//     and no demand stamp can buy a refresh later. A cache miss is skipped, so
//     the demo says the record is not in today's snapshot.
//     The secondary pages' shared data (./demo-snapshot-shared.ts) is read the
//     same way: in-process shared readers over stored tables, shared
//     argument-only RPCs (DEMO_SHARED_RPCS), and REST GET replays of the shared
//     tables in DEMO_REST_TABLES, each refused before any read when the table,
//     a filter or a column is personal.
//   * It never stores personal or workspace data. Every body is scrubbed and a
//     body that still carries an owner field is refused.
//
// BOUNDS. At most maxEntries requests, each under entryTimeoutMs, and the run
// stops starting new work at budgetMs. The planned request list for the day is
// stored once (snapshots/<date>/_plan.json) so a later invocation resumes from
// the cursor over the SAME list.
//
// SAME-DAY REBUILDS. The day's first build writes straight into
// snapshots/<date>/, which no manifest names yet. A later build of a day that is
// already being served (the afternoon and evening refresh ticks after the RWA
// wrapper captures, or a super admin's forced rebuild) is a new GENERATION: its
// plan's createdAt. It computes every entry into staging/<date>/<generation>/
// while the old copy keeps serving untouched, then commits (copies each staged
// entry over the served one, each an atomic overwrite), then writes latest.json
// with the new build time, then clears the staging files. Nothing is deleted from
// the served day, and its manifest keeps every key the old one named that is
// still present, so a rebuild that reads less than the morning did never blanks
// a page. A manifest with no keys is never published.
// The cursor runs over [0, N) while computing and [N, 2N) while committing.

import { captureReadEnvelope } from './capture-read-envelope.ts'
import {
  DEMO_BUCKET, DEMO_DATE_PATTERN, DEMO_LATEST_PATH, DEMO_SHARED_RPCS, DEMO_SNAPSHOT_KEY_VERSION, demoEntryPath, demoRequestKey,
  demoRestRefusal, materializeRestQuery,
} from './demo-snapshot-key.ts'

// deno-lint-ignore no-explicit-any
type Db = any
type Body = Record<string, unknown>

export { DEMO_BUCKET }

export interface DemoRequest { fn: string; body: Body; key?: string; group?: string }
export interface DemoEntry { version: number; key: string; fn: string; status: number; body: unknown }

/** Minimal storage surface: the builder never needs more than this. */
export interface DemoStorage {
  upload(path: string, text: string, opts: { cacheSeconds: number }): Promise<void>
  download(path: string): Promise<string | null>
  list(prefix: string): Promise<string[]>
  remove(paths: string[]): Promise<void>
}

/** Serves one free RWA research read from the shared cache only. Null = skip. */
export type ResearchCacheReader = (capability: string, params: Record<string, unknown>) => Promise<Body | null>

/** Replays one allowlisted REST GET with the service role (query already
 * materialised). Rows and the exact count, or null when the read failed. */
export type RestReplay = (table: string, query: string) => Promise<{ rows: unknown[]; count: number | null } | null>

/** An in-process shared reader for one Edge Function's request body. Null = skip. */
export type FunctionReader = (body: Body, now: number) => Promise<{ status: number; body: unknown } | null>

export interface BuildDeps {
  db: Db
  storage: DemoStorage
  env: (key: string) => string | undefined
  now?: () => number
  research?: ResearchCacheReader
  /** REST GET replays of the shared tables in DEMO_REST_TABLES. */
  rest?: RestReplay
  /** In-process shared readers, by Edge Function name. */
  functions?: Record<string, FunctionReader>
  planner?: (db: Db, now: number) => Promise<DemoRequest[]>
}

export interface BuildOptions {
  trigger: 'cron' | 'super_admin'
  cursor?: number | null
  maxEntries?: number
  entryTimeoutMs?: number
  budgetMs?: number
  keepDates?: number
  force?: boolean
  concurrency?: number
  /** Entries computed by one invocation before it hands on with a cursor. Edge
   * Functions also stop on CPU time, not only wall time, so a run is kept short. */
  maxEntriesPerRun?: number
  /** Staged entries committed by one invocation (I/O only, so more than computed). */
  maxCommitsPerRun?: number
  /** A later build of a day that is already built (the refresh ticks). Starts a new
   * generation when the day's newest run finished it; resumes a stalled build. */
  refresh?: boolean
  /** The generation a hand-off continues (its plan's createdAt). When the stored
   * plan is a newer generation, this hop stops without doing anything. */
  generation?: string | null
}

export const DEFAULT_MAX_ENTRIES = 2500
export const DEFAULT_ENTRY_TIMEOUT_MS = 12_000
export const DEFAULT_BUDGET_MS = 120_000
export const DEFAULT_KEEP_DATES = 3
export const DEFAULT_CONCURRENCY = 4
export const DEFAULT_ENTRIES_PER_RUN = 30
export const DEFAULT_COMMITS_PER_RUN = 300
/** A tick (no cursor) that finds the day's newest run partial and younger than
 * this leaves it alone: that build is still handing on, and resuming it as well
 * would start a second chain over the same cursor. */
export const ACTIVE_CHAIN_MS = 10 * 60_000
export const DEMO_STAGING_PREFIX = 'staging'
const PLAN_FILE = '_plan.json'
const MAX_BODY_BYTES = 4_500_000

/** pg_cron jobs that call intel-demo-snapshot. The migrations named here schedule
 * exactly these (asserted by demo-snapshot-builder.test.ts). Minutes checked
 * against every active cron.job on 2026-09-23: :19 of hours 15 and 21 is used
 * only by the every-minute jobs. */
export const DEMO_SNAPSHOT_SCHEDULE = Object.freeze({
  daily: { job: 'intel-demo-snapshot-daily', cron: '13 4 * * *', body: { op: 'build' }, migration: '20260923090000_intel_demo_snapshot.sql' },
  // 32 minutes after the six-hourly RWA wrapper capture at :47 of hours 14 and 20
  // (one invocation, 110 s timeout) and 12 minutes after intel-capture-hourly at :07.
  refresh: { job: 'intel-demo-snapshot-refresh', cron: '19 15,21 * * *', body: { op: 'build', refresh: true }, migration: '20260923221000_intel_demo_snapshot_refresh.sql' },
})

// ─── scrubbing ────────────────────────────────────────────────────────────────

/** Keys whose values are personal data. Dropped wherever they appear. */
export const SCRUB_KEYS = new Set(['email', 'full_name', 'phone', 'avatar_url'])
/** Keys that mean a row belongs to a person or a workspace. A body carrying one
 * with a value is refused outright rather than cleaned: a personal-table row in
 * a public file is a bug upstream, not something to paper over. */
export const OWNER_KEYS = new Set([
  'user_id', 'userId', 'org_id', 'orgId', 'owner_id', 'ownerId', 'created_by', 'createdBy',
  'demand_user_id', 'demand_org_id', 'member_id', 'profile_id', 'telegram_chat_id', 'wallet_owner',
])
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

export class PersonalDataError extends Error {
  constructor(public path: string) { super(`personal_data_in_body:${path}`) }
}

/** Drop personal keys, redact email addresses, refuse owner-bearing rows. */
export function scrubBody(value: unknown, path = '$', depth = 0): unknown {
  if (depth > 64) return null
  if (typeof value === 'string') return value.replace(EMAIL, '[redacted]')
  if (Array.isArray(value)) return value.map((item, i) => scrubBody(item, `${path}[${i}]`, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SCRUB_KEYS.has(key)) continue
      if (OWNER_KEYS.has(key) && inner != null && inner !== '') throw new PersonalDataError(`${path}.${key}`)
      out[key] = scrubBody(inner, `${path}.${key}`, depth + 1)
    }
    return out
  }
  return value
}

// ─── helpers ──────────────────────────────────────────────────────────────────

export function utcDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10) }

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('entry_timeout')), ms) as unknown as number }),
    ])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Keyed and de-duplicated, first occurrence wins, capped. */
export function finalizePlan(requests: DemoRequest[], maxEntries = DEFAULT_MAX_ENTRIES): DemoRequest[] {
  const seen = new Set<string>(), out: DemoRequest[] = []
  for (const request of requests) {
    const key = demoRequestKey(request)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ ...request, key })
    if (out.length >= maxEntries) break
  }
  return out
}

/** One stored body, computed in-process. Null means "leave it out". */
export async function computeEntry(request: DemoRequest, deps: BuildDeps, now: number): Promise<{ status: number; body: unknown } | null> {
  if (request.fn === 'intel-capture') {
    const startedAt = Date.now()
    const read = await captureReadEnvelope(deps.db, request.body, { now, startedAt, env: deps.env })
    // A refused read is not a snapshot of anything: the demo shows its own line.
    if (read.status !== 200) return null
    return { status: 200, body: read.body }
  }
  if (request.fn === 'intel-research') {
    if (!deps.research) return null
    const capability = String(request.body.capability || '')
    const params = (request.body.params && typeof request.body.params === 'object') ? request.body.params as Record<string, unknown> : {}
    const body = await deps.research(capability, params)
    return body ? { status: 200, body } : null
  }
  if (request.fn === 'rest') {
    // A shared-table GET. Refused outright (not skipped) when the allowlist says
    // no: a personal table in the plan is a bug, and the run records it.
    const table = String(request.body.table || ''), query = String(request.body.query || '')
    const refusal = demoRestRefusal(table, query)
    if (refusal) throw new Error(`rest_refused:${refusal}`)
    if (!deps.rest) return null
    const read = await deps.rest(table, materializeRestQuery(query, now))
    return read ? { status: 200, body: { rows: read.rows, count: read.count } } : null
  }
  if (request.fn === 'rpc') {
    const name = String(request.body.name || '')
    if (!DEMO_SHARED_RPCS.has(name)) throw new Error(`rpc_refused:${name.slice(0, 60)}`)
    const args = (request.body.args && typeof request.body.args === 'object') ? request.body.args : {}
    const { data, error } = await deps.db.rpc(name, args)
    return error || data == null ? null : { status: 200, body: data }
  }
  const reader = deps.functions?.[request.fn]
  return reader ? await reader(request.body, now) : null
}

// ─── the run ──────────────────────────────────────────────────────────────────

export interface RunResult {
  date: string
  status: 'complete' | 'partial' | 'failed' | 'already_built' | 'in_progress' | 'superseded'
  planned: number
  cursor: number | null
  written: number
  skipped: number
  failed: number
  bytes: number
  /** Staged entries this invocation copied over the served ones. */
  committed: number
  latestWritten: boolean
  /** The build generation (its plan's createdAt) this invocation worked on. */
  generation: string | null
  /** The generation stages its entries because its date was already being served. */
  staged: boolean
  prunedDates: string[]
  errors: { key: string; reason: string }[]
  durationMs: number
}

interface StoredPlan { version: number; date: string; createdAt: string; requests: DemoRequest[]; stage?: string | null }

/** The generation's folder name under staging/<date>/: its createdAt, digits only. */
export function generationId(createdAt: string): string { return String(createdAt).replace(/[^0-9TZ]/g, '') }
const GENERATION_PATTERN = /^\d{8}T\d{6,9}Z$/

interface PreviousRuns { cursor: number | null; latestWritten: boolean; activeChain: boolean }

async function loadRuns(db: Db, date: string, now: number): Promise<PreviousRuns> {
  try {
    const { data, error } = await db.from('intel_demo_snapshot_runs').select('resume_cursor,latest_written,status,finished_at')
      .eq('snapshot_date', date).order('id', { ascending: false }).limit(20)
    if (error) console.warn('intel_demo_snapshot_runs_read_failed', String(error.message || error).slice(0, 200))
    const rows = Array.isArray(data) ? data : []
    const newest = rows[0]
    const partial = rows.length > 0 && newest?.status === 'partial'
    const finishedAt = Date.parse(String(newest?.finished_at || ''))
    return {
      // Only the newest run decides: a forced rebuild in progress (newest row partial)
      // must keep handing on even though an earlier run finished today.
      latestWritten: newest?.latest_written === true,
      cursor: partial && Number.isFinite(Number(newest?.resume_cursor)) ? Number(newest.resume_cursor) : null,
      activeChain: partial && Number.isFinite(finishedAt) && now - finishedAt < ACTIVE_CHAIN_MS,
    }
  } catch { return { cursor: null, latestWritten: false, activeChain: false } }
}

async function recordRun(db: Db, row: Body): Promise<void> {
  try {
    const { error } = await db.from('intel_demo_snapshot_runs').insert(row)
    if (error) console.warn('intel_demo_snapshot_run_log_failed', String(error.message || error).slice(0, 200))
  } catch (e) { console.warn('intel_demo_snapshot_run_log_failed', String((e as Error)?.message || e).slice(0, 200)) }
}

/** latest.json as it is served right now, or null. */
async function servedManifest(storage: DemoStorage): Promise<{ date: string; keys: string[] } | null> {
  try {
    const raw = await storage.download(DEMO_LATEST_PATH)
    const parsed = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || !DEMO_DATE_PATTERN.test(String(parsed.date || ''))) return null
    return { date: String(parsed.date), keys: Array.isArray(parsed.keys) ? parsed.keys.map(String) : [] }
  } catch { return null }
}

async function prune(storage: DemoStorage, keepDates: number): Promise<string[]> {
  const names = await storage.list('snapshots')
  const dates = [...new Set(names.filter((n) => DEMO_DATE_PATTERN.test(n)))].sort().reverse()
  const drop = dates.slice(Math.max(1, keepDates))
  for (const date of drop) {
    const files = await storage.list(`snapshots/${date}`)
    const paths = files.map((f) => `snapshots/${date}/${f}`)
    for (let i = 0; i < paths.length; i += 500) await storage.remove(paths.slice(i, i + 500))
  }
  return drop
}

/** Removes the staging files of this generation and of every older one, any date.
 * A newer generation's files are left for it. */
async function clearStaging(storage: DemoStorage, upTo: string): Promise<void> {
  for (const date of (await storage.list(DEMO_STAGING_PREFIX)).filter((n) => DEMO_DATE_PATTERN.test(n))) {
    for (const gen of await storage.list(`${DEMO_STAGING_PREFIX}/${date}`)) {
      if (!GENERATION_PATTERN.test(gen) || gen > upTo) continue
      const dir = `${DEMO_STAGING_PREFIX}/${date}/${gen}`
      const paths = (await storage.list(dir)).map((f) => `${dir}/${f}`)
      for (let i = 0; i < paths.length; i += 500) await storage.remove(paths.slice(i, i + 500))
    }
  }
}

/** The body of the next hop, or null when this invocation must not hand on. A
 * super admin who passed a cursor is stepping by hand and drives the next step
 * themselves: handing on as well would start a second chain over the same cursor
 * (on 2026-09-23 hand-stepping a forced rebuild forked it into dozens of chains). */
export function nextHopBody(result: RunResult, ctx: { cronOk: boolean; manualCursor: boolean; hop: number; maxHops: number }): Record<string, unknown> | null {
  if (result.status !== 'partial' || result.cursor == null) return null
  if (ctx.hop >= ctx.maxHops) return null
  if (!ctx.cronOk && ctx.manualCursor) return null
  return { op: 'build', cursor: result.cursor, hop: ctx.hop + 1, ...(result.generation ? { generation: result.generation } : {}) }
}

export async function buildDemoSnapshot(deps: BuildDeps, opts: BuildOptions): Promise<RunResult> {
  const clock = deps.now ?? (() => Date.now())
  const started = clock()
  const maxEntries = Math.max(1, Math.min(5000, opts.maxEntries ?? DEFAULT_MAX_ENTRIES))
  const entryTimeoutMs = Math.max(1000, opts.entryTimeoutMs ?? DEFAULT_ENTRY_TIMEOUT_MS)
  const budgetMs = Math.max(5000, opts.budgetMs ?? DEFAULT_BUDGET_MS)
  const deadline = started + budgetMs
  const date = utcDate(started)
  const result: RunResult = {
    date, status: 'partial', planned: 0, cursor: null, written: 0, skipped: 0, failed: 0, bytes: 0, committed: 0,
    latestWritten: false, generation: null, staged: false, prunedDates: [], errors: [], durationMs: 0,
  }
  const finish = async (status: RunResult['status']) => {
    result.status = status
    result.durationMs = clock() - started
    // Only work is logged: a tick that finds nothing to do leaves no row.
    if (status === 'complete' || status === 'partial' || status === 'failed') {
      await recordRun(deps.db, {
        snapshot_date: date, started_at: new Date(started).toISOString(), status,
        run_trigger: opts.trigger, entries_written: result.written, entries_skipped: result.skipped, entries_failed: result.failed,
        bytes_written: result.bytes, resume_cursor: result.cursor, latest_written: result.latestWritten, duration_ms: result.durationMs,
        detail: {
          planned: result.planned, pruned: result.prunedDates, errors: result.errors.slice(0, 50),
          generation: result.generation, staged: result.staged, committed: result.committed,
        },
      })
    }
    return result
  }

  try {
    const previous = await loadRuns(deps.db, date, started)
    const hop = opts.cursor != null
    if (!opts.force) {
      if (previous.latestWritten && !opts.refresh) return await finish('already_built')
      // A tick while today's build is still handing on leaves it alone.
      if (!hop && previous.activeChain) return await finish('in_progress')
    }
    // A new generation: forced, or a refresh tick on a day whose newest run finished it.
    const fresh = opts.force === true || (opts.refresh === true && previous.latestWritten && !hop)

    // The day's plan: stored once per generation, reused by every resuming invocation.
    const planPath = `snapshots/${date}/${PLAN_FILE}`
    let plan: StoredPlan | null = null
    const resuming = !fresh && (opts.cursor != null || previous.cursor != null)
    if (resuming) {
      try { const raw = await deps.storage.download(planPath); plan = raw ? JSON.parse(raw) : null } catch { plan = null }
      if (plan && (plan.version !== DEMO_SNAPSHOT_KEY_VERSION || plan.date !== date || !Array.isArray(plan.requests))) plan = null
    }
    // A hand-off from a generation a newer plan has replaced stops here.
    if (plan && hop && opts.generation && plan.createdAt !== opts.generation) {
      result.generation = plan.createdAt
      return await finish('superseded')
    }
    // A cursor only means something over the list it was taken from.
    const resumed = resuming && plan != null
    if (!plan) {
      if (!deps.planner) throw new Error('no_planner')
      const requests = finalizePlan(await deps.planner(deps.db, started), maxEntries)
      const createdAt = new Date(started).toISOString()
      // The day is already being served: stage, so the old copy keeps serving
      // until the new one is complete.
      const served = await servedManifest(deps.storage)
      const stage = served?.date === date ? `${DEMO_STAGING_PREFIX}/${date}/${generationId(createdAt)}` : null
      plan = { version: DEMO_SNAPSHOT_KEY_VERSION, date, createdAt, requests, stage }
      await deps.storage.upload(planPath, JSON.stringify(plan), { cacheSeconds: 60 })
      // Planning reads the day's data to enumerate every variant, which is the
      // heaviest single step; it gets an invocation of its own and hands on.
      result.planned = plan.requests.length
      result.generation = createdAt
      result.staged = stage != null
      result.cursor = 0
      return await finish('partial')
    }
    result.planned = plan.requests.length
    result.generation = plan.createdAt
    const stage = plan.stage ? String(plan.stage) : null
    if (stage != null && stage !== `${DEMO_STAGING_PREFIX}/${date}/${generationId(plan.createdAt)}`) throw new Error('plan_stage_mismatch')
    result.staged = stage != null
    const total = plan.requests.length
    const end = stage ? 2 * total : total
    let index = resumed ? Math.max(0, Math.min(end, Number(opts.cursor ?? previous.cursor ?? 0))) : 0
    const entryPath = (key: string) => (stage ? `${stage}/${key}.json` : demoEntryPath(date, key))

    // Small concurrent batches. The cursor is the first request of the first
    // batch not started, so a resumed run never skips or repeats a batch.
    const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? DEFAULT_CONCURRENCY))
    const one = async (request: DemoRequest) => {
      const key = request.key || demoRequestKey(request)
      try {
        const entry = await withTimeout(() => computeEntry(request, deps, clock()), entryTimeoutMs)
        if (!entry) { result.skipped++; return }
        const body = scrubBody(entry.body)
        const stored: DemoEntry = { version: DEMO_SNAPSHOT_KEY_VERSION, key, fn: request.fn, status: entry.status, body }
        const text = JSON.stringify(stored)
        if (text.length > MAX_BODY_BYTES) { result.skipped++; result.errors.push({ key, reason: 'entry_too_large' }); return }
        await deps.storage.upload(entryPath(key), text, { cacheSeconds: 3600 })
        result.written++
        result.bytes += text.length
      } catch (e) {
        result.failed++
        result.errors.push({ key, reason: String((e as Error)?.message || e).slice(0, 160) })
      }
    }
    if (index < total) {
      const perRun = Math.max(1, Math.min(500, opts.maxEntriesPerRun ?? DEFAULT_ENTRIES_PER_RUN))
      const stopAt = Math.min(total, index + perRun)
      while (index < stopAt) {
        if (clock() > deadline) break
        const batch = plan.requests.slice(index, Math.min(stopAt, index + concurrency))
        await Promise.all(batch.map(one))
        index += batch.length
      }
      if (index < total) {
        result.cursor = index
        return await finish('partial')
      }
    }

    // A staged generation: every entry is computed; copy each staged one over the
    // served one. Each copy is one atomic overwrite, so a reader gets the old or
    // the new body of an entry, never nothing.
    if (stage && index < end) {
      const staged = new Set((await deps.storage.list(stage))
        .filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length)))
      // Nothing computed: publish nothing, and the served copy stays as it is.
      if (!staged.size) throw new Error('nothing_staged')
      const commitStop = Math.min(end, index + Math.max(1, Math.min(2000, opts.maxCommitsPerRun ?? DEFAULT_COMMITS_PER_RUN)))
      const commitOne = async (request: DemoRequest) => {
        const key = request.key || demoRequestKey(request)
        if (!staged.has(key)) return
        try {
          const text = await deps.storage.download(`${stage}/${key}.json`)
          if (text == null) throw new Error('staged_entry_unreadable')
          await deps.storage.upload(demoEntryPath(date, key), text, { cacheSeconds: 3600 })
          result.committed++
        } catch (e) {
          result.failed++
          result.errors.push({ key, reason: `commit:${String((e as Error)?.message || e).slice(0, 150)}` })
        }
      }
      while (index < commitStop) {
        if (clock() > deadline) break
        const from = index - total
        const batch = plan.requests.slice(from, Math.min(commitStop - total, from + 8))
        await Promise.all(batch.map(commitOne))
        index += batch.length
      }
      if (index < end) {
        result.cursor = index
        return await finish('partial')
      }
    }

    // Every planned request has been attempted. The manifest names exactly the
    // files present for this date (across every invocation), and goes up last.
    const present = new Set((await deps.storage.list(`snapshots/${date}`))
      .filter((name) => name.endsWith('.json') && name !== PLAN_FILE)
      .map((name) => name.slice(0, -'.json'.length)))
    const keys = plan.requests.map((r) => r.key!).filter((k) => present.has(k))
    if (stage) {
      // A same-day rebuild keeps every page the served manifest names whose entry
      // is still there (its body states its own time), so it never blanks one.
      const served = await servedManifest(deps.storage)
      if (served?.date === date) {
        const listed = new Set(keys)
        for (const key of served.keys) if (present.has(key) && !listed.has(key)) { keys.push(key); listed.add(key) }
      }
    }
    // An empty manifest would blank the whole demo: keep serving what is there.
    if (!keys.length) throw new Error('no_entries')
    const latest = { date, capturedAt: plan.createdAt, version: DEMO_SNAPSHOT_KEY_VERSION, keys }
    await deps.storage.upload(DEMO_LATEST_PATH, JSON.stringify(latest), { cacheSeconds: 300 })
    result.latestWritten = true
    try { await clearStaging(deps.storage, generationId(plan.createdAt)) } catch (e) {
      result.errors.push({ key: 'staging', reason: String((e as Error)?.message || e).slice(0, 160) })
    }
    try { result.prunedDates = await prune(deps.storage, opts.keepDates ?? DEFAULT_KEEP_DATES) } catch (e) {
      result.errors.push({ key: 'prune', reason: String((e as Error)?.message || e).slice(0, 160) })
    }
    return await finish('complete')
  } catch (e) {
    result.errors.push({ key: 'run', reason: String((e as Error)?.message || e).slice(0, 160) })
    return await finish('failed')
  }
}
