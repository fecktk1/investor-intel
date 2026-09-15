// Investor Intel — read view over the meme launch-stage capture tables
// (CMC plan proposal 30).
//
// Same contract as `capture-read.ts` and `capture-categories-read.ts`: pure
// functions over a PostgREST-shaped `db`, every read bounded by an explicit row
// cap, ordered newest-first so that hitting a cap loses the OLDEST rows, and
// `coverage` reporting the window actually read ({from, to, count}) with
// `truncated`. An empty table is an empty answer with `asOf: null` — never an
// error, and never a fabricated zero point. A valid zero stays a zero: a cohort
// with members and no graduates has `graduationRate: 0`, not null.
//
// DEFINITIONS, stated here because the numbers mean nothing without them:
//
//   funnel        the stage board of the NEWEST capture only. `count` is the
//                 true count for the stage; `contracts` is a bounded sample of
//                 that stage's cohort (at most FUNNEL_CONTRACTS) so the read
//                 stays small — the cap is reported on the row.
//
//   graduationRate  a COHORT rate, not a ratio of two unrelated populations:
//                 the denominator is the distinct contracts whose
//                 `first_seen_at` falls inside the window (the new creations of
//                 the window), and the numerator is how many of THOSE reached
//                 the `graduates` stage inside the same window. It is therefore
//                 always between 0 and 1. It is null when the denominator is 0 —
//                 an unmeasurable rate is never reported as zero.
//
//   timeToGraduate  from the transitions table, `newCreations → graduates` only,
//                 using the `hours_since_first_seen` recorded at the moment of
//                 the transition. It is time since WE FIRST SAW the contract,
//                 not since deployment. Null when no such transition is retained
//                 in the window. Percentiles are linear-interpolated on the
//                 sorted sample; the histogram uses fixed hour edges and keeps
//                 empty buckets as zeros.
//
//   retention     of the same cohort, how many contracts were still on a stage
//                 list at least H hours after their own first sighting.
//                 `eligible` is how many of the cohort have HAD H hours since
//                 first sighting — a contract first seen twenty minutes ago
//                 cannot fail a 24-hour test, so it is not counted against it.
//
// The tables are service-role only; this read runs inside the `intel-capture`
// Edge Function behind an authenticated Intel membership check.

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const MEME_DAYS = [1, 7, 30]
/** A 30-day window of hourly rows for up to 75 contracts a platform is large;
 * the read keeps the newest rows and reports the truncation rather than
 * silently describing part of the window as if it were all of it. */
const SNAPSHOT_CAP = 6000
const TRANSITION_CAP = 2000
const RECENT_MAX = 50
export const FUNNEL_CONTRACTS = 25
export const MEME_STAGES = ['newCreations', 'aboutGraduates', 'graduates'] as const
/** Hour edges of the time-to-graduate histogram. The last bucket is open-ended. */
export const HISTOGRAM_EDGES = [0, 1, 3, 6, 12, 24, 48, 72, 168]
export const RETENTION_HOURS = [1, 6, 24, 72]

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short series. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** Linear-interpolated percentile over a sorted numeric sample. */
export function percentile(sorted: number[], fraction: number): number | null {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, fraction))
  const low = Math.floor(position), high = Math.ceil(position)
  if (low === high) return sorted[low]
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low)
}

/** Fixed-edge histogram. Empty buckets stay in the answer as zeros. */
export function histogram(values: number[]): { fromHours: number; toHours: number | null; count: number }[] {
  const buckets = HISTOGRAM_EDGES.map((from, i) => ({ fromHours: from, toHours: HISTOGRAM_EDGES[i + 1] ?? null, count: 0 }))
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) continue
    let index = 0
    for (let i = 0; i < buckets.length; i++) { if (value >= buckets[i].fromHours) index = i }
    buckets[index].count += 1
  }
  return buckets
}

const SNAPSHOT_COLUMNS = 'platform_id,chain,contract_address,captured_at,stage,name,symbol,price,market_cap,first_seen_at'
const TRANSITION_COLUMNS = 'chain,contract_address,from_stage,to_stage,at,hours_since_first_seen'

interface Row {
  chain: string; contractAddress: string; capturedAt: string; stage: string
  name: string | null; symbol: string | null; price: number | null; marketCap: number | null; firstSeenAt: string | null
}

// deno-lint-ignore no-explicit-any
const snapshotRow = (row: any): Row | null => {
  const chain = str(row?.chain, 60), contractAddress = str(row?.contract_address, 200), capturedAt = str(row?.captured_at, 40)
  if (!chain || !contractAddress || !capturedAt) return null
  return {
    chain, contractAddress, capturedAt, stage: str(row?.stage, 40) ?? '',
    name: str(row?.name, 200), symbol: str(row?.symbol, 50),
    price: num(row?.price), marketCap: num(row?.market_cap), firstSeenAt: str(row?.first_seen_at, 40),
  }
}

/**
 * The meme graduation funnel, cohort rate, time-to-graduate distribution and
 * retention for one window, optionally for one chain.
 */
// deno-lint-ignore no-explicit-any
export async function readMemeGraduation(db: any, params: { days?: unknown; chain?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = Math.trunc(Number(params.days))
  const days = MEME_DAYS.includes(requested) ? requested : 7
  const chain = str(params.chain, 60)
  const nowMs = at(now), windowStart = new Date(nowMs - days * 86_400_000).toISOString()
  const empty = (reason: string | null): ViewResult => ({
    view: 'meme_graduation', days, chain, funnel: [], graduationRate: null,
    timeToGraduate: null, retention: [], recent: [], asOf: null, coverage: emptyCoverage(), reason,
  })

  const snapshots = await readRows(() => {
    let q = db.from('intel_meme_stage_snapshots').select(SNAPSHOT_COLUMNS).gte('captured_at', windowStart)
    if (chain) q = q.eq('chain', chain)
    return q.order('captured_at', { ascending: false }).limit(SNAPSHOT_CAP)
  })
  const rows = snapshots.rows.map(snapshotRow).filter((row): row is Row => !!row)
  if (!rows.length) return empty(snapshots.reason)

  const stamps = rows.map((row) => row.capturedAt).sort()
  const asOf = stamps.at(-1) ?? null

  // ── funnel: the newest capture only ──
  const newest = rows.filter((row) => row.capturedAt === asOf)
  const funnel = MEME_STAGES.map((stage) => {
    const members = newest.filter((row) => row.stage === stage)
    return {
      stage, count: members.length,
      contracts: members.slice(0, FUNNEL_CONTRACTS).map((row) => ({
        chain: row.chain, contractAddress: row.contractAddress, symbol: row.symbol, name: row.name,
        marketCap: row.marketCap, firstSeenAt: row.firstSeenAt,
      })),
      contractsTruncated: members.length > FUNNEL_CONTRACTS,
    }
  })

  // ── cohort: distinct contracts first seen inside the window ──
  const cohort = new Map<string, { firstSeen: number; lastSeen: number; graduated: boolean }>()
  for (const row of rows) {
    const firstSeen = Date.parse(String(row.firstSeenAt ?? ''))
    if (!Number.isFinite(firstSeen) || firstSeen < Date.parse(windowStart)) continue
    const key = `${row.chain}|${row.contractAddress}`
    const seen = Date.parse(row.capturedAt)
    const entry = cohort.get(key) ?? { firstSeen, lastSeen: seen, graduated: false }
    entry.firstSeen = Math.min(entry.firstSeen, firstSeen)
    entry.lastSeen = Math.max(entry.lastSeen, Number.isFinite(seen) ? seen : entry.lastSeen)
    entry.graduated = entry.graduated || row.stage === 'graduates'
    cohort.set(key, entry)
  }
  const denominator = cohort.size
  const numerator = [...cohort.values()].filter((entry) => entry.graduated).length
  // An unmeasurable rate is null. A measured zero is a zero.
  const graduationRate = denominator > 0 ? numerator / denominator : null

  // ── time to graduate: newCreations → graduates transitions in the window ──
  const moves = await readRows(() => {
    let q = db.from('intel_meme_stage_transitions').select(TRANSITION_COLUMNS)
      .eq('to_stage', 'graduates').eq('from_stage', 'newCreations').gte('at', windowStart)
    if (chain) q = q.eq('chain', chain)
    return q.order('at', { ascending: false }).limit(TRANSITION_CAP)
  })
  const hours = moves.rows.map((row) => num(row?.hours_since_first_seen)).filter((v): v is number => v != null && v >= 0).sort((a, b) => a - b)
  const timeToGraduate = hours.length ? {
    median: percentile(hours, 0.5), p25: percentile(hours, 0.25), p75: percentile(hours, 0.75),
    sample: hours.length, histogram: histogram(hours),
  } : null

  // ── retention: still listed H hours after first sighting ──
  const retention = RETENTION_HOURS.map((hoursSinceFirstSeen) => {
    const window = hoursSinceFirstSeen * 3_600_000
    const eligible = [...cohort.values()].filter((entry) => entry.firstSeen + window <= nowMs)
    return {
      hoursSinceFirstSeen,
      stillListed: eligible.filter((entry) => entry.lastSeen - entry.firstSeen >= window).length,
      eligible: eligible.length,
    }
  })

  // ── recent: the newest sightings, newest first ──
  const seenContract = new Set<string>()
  const recent: Record<string, unknown>[] = []
  for (const row of rows) {
    const key = `${row.chain}|${row.contractAddress}`
    if (seenContract.has(key)) continue
    seenContract.add(key)
    recent.push({
      chain: row.chain, contractAddress: row.contractAddress, symbol: row.symbol, name: row.name,
      stage: row.stage, firstSeenAt: row.firstSeenAt, capturedAt: row.capturedAt, marketCap: row.marketCap,
    })
    if (recent.length >= RECENT_MAX) break
  }

  return {
    view: 'meme_graduation', days, chain,
    funnel, graduationRate,
    cohort: { firstSeenInWindow: denominator, graduatedInWindow: numerator },
    timeToGraduate, retention, recent,
    asOf,
    coverage: {
      from: stamps[0] ?? null, to: asOf, count: snapshots.rows.length,
      truncated: snapshots.rows.length >= SNAPSHOT_CAP || moves.rows.length >= TRANSITION_CAP,
    },
    reason: snapshots.reason || moves.reason || null,
  }
}

/** Integration surface. The reviewer wires these into the Edge Function's read
 * half alongside `readCaptureView`. */
export const MEME_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  meme_graduation: (db, body, now) => readMemeGraduation(db, body, now),
}
