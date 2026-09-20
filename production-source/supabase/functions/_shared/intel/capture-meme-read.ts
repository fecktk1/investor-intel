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
//   launchpads    the SAME three numbers per launchpad (funnel, cohort rate,
//                 time to graduate), so the page can say that Pump.fun graduates
//                 at one rate and Four.meme at another instead of averaging two
//                 unrelated populations into one meaningless figure. `chains` is
//                 the same grouping one level up.
//
//   captures      how many distinct capture HOURS the window holds, in total and
//                 per group. Transitions, graduation rates and times to graduate
//                 are all derived from movement between captures, so a group
//                 with one capture has no history yet: the page states that
//                 rather than presenting an unmeasured 0%.
//
//   sources       which capture lane each row came from, its newest capture
//                 clock and how many rows of the window it contributed. The two
//                 lanes write the SAME tables, so without this a reader cannot
//                 tell a CoinMarketCap-only window from a CoinGecko-only one.
//
//   attribution   CoinGecko's paid terms require a visible "Powered by CoinGecko"
//                 notice (font size at least 10) wherever this data is shown.
//                 It is part of the payload rather than a constant in the page so
//                 the page cannot render the data without being handed the notice.
//
// TWO SOURCES, ONE ROW PER CONTRACT PER HOUR. The primary key is
// (chain, contract_address, captured_at) and `source` names the FIRST writer, so
// nothing here has to de-duplicate across sources: a contract both lanes saw in
// one hour is one row, and every count below is a count of contracts.
//
// The tables are service-role only; this read runs inside the `intel-capture`
// Edge Function behind an authenticated Intel membership check.

import { capByEntity, capWithinRuns } from './feed-entity-cap.ts'
import { CHAIN_LABELS, COINGECKO_ATTRIBUTION, PAD_CHAINS, PAD_LABELS } from './launchpad-registry.ts'

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

const MEME_DAYS = [1, 7, 30]
/** A 30-day window of hourly rows for up to 75 contracts a platform is large;
 * the read keeps the newest rows and reports the truncation rather than
 * silently describing part of the window as if it were all of it. */
const SNAPSHOT_CAP = 6000
const TRANSITION_CAP = 2000
const RECENT_MAX = 50
/** How many contracts one launch platform may place ahead of the others.
 *
 * ENTITY: the launch platform (`platform_id`, one launchpad on one chain), with
 * the chain as the fallback key when a row names no platform. A meme board is
 * flooded by whichever launchpad is busiest that hour, and that is a platform
 * event rather than a chain event: two launchpads on one chain are two different
 * sources of contracts. The contract itself is already unique per row.
 *
 * POLICIES. The funnel sample is a FIXED-SIZE board drawn from the newest capture
 * only, whose members are tied on the capture clock, so it backfills: it is never
 * shorter than it was. `recent` is ordered newest sighting first and says so on
 * the page, so rows are deferred only among contracts sighted by the SAME
 * capture and never moved behind an older sighting. */
const FUNNEL_PER_PLATFORM = 10
const RECENT_PER_PLATFORM = 15
/** Unique contracts considered for `recent` before the cap. Bounded so the cap
 * has rows to defer into without walking the whole window. */
const RECENT_CANDIDATES = RECENT_MAX * 4
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

const SNAPSHOT_COLUMNS = 'platform_id,chain,contract_address,captured_at,stage,name,symbol,price,market_cap,first_seen_at,source,launchpad,graduation_pct,completed_at,migration_pool,fdv'
const TRANSITION_COLUMNS = 'chain,contract_address,from_stage,to_stage,at,hours_since_first_seen,source,launchpad'

interface Row {
  platformId: string | null
  chain: string; contractAddress: string; capturedAt: string; stage: string
  name: string | null; symbol: string | null; price: number | null; marketCap: number | null; firstSeenAt: string | null
  source: string; launchpad: string | null; graduationPct: number | null
  completedAt: string | null; migrationPool: string | null; fdv: number | null
}

const platformOf = (row: { platformId: string | null; chain: string }) => row.platformId ? `platform:${row.platformId}` : `chain:${row.chain}`

// deno-lint-ignore no-explicit-any
const snapshotRow = (row: any): Row | null => {
  const chain = str(row?.chain, 60), contractAddress = str(row?.contract_address, 200), capturedAt = str(row?.captured_at, 40)
  if (!chain || !contractAddress || !capturedAt) return null
  return {
    platformId: str(row?.platform_id, 40),
    chain, contractAddress, capturedAt, stage: str(row?.stage, 40) ?? '',
    name: str(row?.name, 200), symbol: str(row?.symbol, 50),
    price: num(row?.price), marketCap: num(row?.market_cap), firstSeenAt: str(row?.first_seen_at, 40),
    // A row written before the `source` column existed is a CoinMarketCap row;
    // that is what the column's DEFAULT says, and the read says the same rather
    // than inventing an 'unknown' source the page would have to explain.
    source: str(row?.source, 40) ?? 'coinmarketcap',
    launchpad: str(row?.launchpad, 120), graduationPct: num(row?.graduation_pct),
    completedAt: str(row?.completed_at, 40), migrationPool: str(row?.migration_pool, 120), fdv: num(row?.fdv),
  }
}

interface Move { chain: string; contractAddress: string; launchpad: string | null; hours: number | null }

// deno-lint-ignore no-explicit-any
const moveRow = (row: any): Move | null => {
  const chain = str(row?.chain, 60), contractAddress = str(row?.contract_address, 200)
  if (!chain || !contractAddress) return null
  return { chain, contractAddress, launchpad: str(row?.launchpad, 120), hours: num(row?.hours_since_first_seen) }
}

export interface GroupStats {
  key: string
  label: string
  chain: string | null
  rows: number
  contracts: number
  /** Distinct capture hours this group appears in, inside the window. A cohort
   * rate and a time-to-graduate distribution are both derived from MOVEMENT
   * between captures, so a group seen in one capture has no history yet and the
   * page says so rather than printing a 0% that only means "we looked once". */
  captures: number
  latestCapturedAt: string | null
  funnel: { stage: string; count: number }[]
  cohort: { firstSeenInWindow: number; graduatedInWindow: number }
  graduationRate: number | null
  timeToGraduate: { median: number | null; p25: number | null; p75: number | null; sample: number } | null
}

/**
 * The same three numbers — funnel, cohort rate, time to graduate — for each
 * value of one grouping key.
 *
 * Every rule of the top-level answer is kept here rather than loosened for a
 * smaller population: the funnel counts the NEWEST CAPTURE only, the cohort
 * denominator is the contracts first seen inside the window, and a denominator
 * of 0 yields `graduationRate: null` rather than 0. A group with members and no
 * graduates is a measured zero and stays 0.
 *
 * Grouping by launchpad is the reason this exists. Pump.fun and Four.meme have
 * nothing to do with each other; one rate over both of them is not a fact about
 * either.
 */
function groupStats(
  rows: Row[], moves: Move[], asOf: string | null, windowStartMs: number,
  keyOf: (row: Row) => string | null,
  moveKeyOf: (move: Move) => string | null,
  labelOf: (key: string) => string,
  chainOf: (key: string) => string | null,
): GroupStats[] {
  const keys: string[] = []
  const byKey = new Map<string, Row[]>()
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) continue
    if (!byKey.has(key)) { byKey.set(key, []); keys.push(key) }
    byKey.get(key)!.push(row)
  }
  const movesByKey = new Map<string, number[]>()
  for (const move of moves) {
    const key = moveKeyOf(move)
    if (!key || move.hours == null || move.hours < 0) continue
    const bucket = movesByKey.get(key) ?? []
    bucket.push(move.hours)
    movesByKey.set(key, bucket)
  }
  return keys.map((key) => {
    const mine = byKey.get(key) ?? []
    const cohort = new Map<string, boolean>()
    let latest: string | null = null
    for (const row of mine) {
      if (!latest || row.capturedAt > latest) latest = row.capturedAt
      const firstSeen = Date.parse(String(row.firstSeenAt ?? ''))
      if (!Number.isFinite(firstSeen) || firstSeen < windowStartMs) continue
      const id = `${row.chain}|${row.contractAddress}`
      cohort.set(id, (cohort.get(id) ?? false) || row.stage === 'graduates')
    }
    const denominator = cohort.size
    const numerator = [...cohort.values()].filter(Boolean).length
    const newest = asOf ? mine.filter((row) => row.capturedAt === asOf) : []
    const hours = (movesByKey.get(key) ?? []).slice().sort((a, b) => a - b)
    return {
      key, label: labelOf(key), chain: chainOf(key),
      rows: mine.length,
      contracts: new Set(mine.map((row) => `${row.chain}|${row.contractAddress}`)).size,
      captures: new Set(mine.map((row) => row.capturedAt)).size,
      latestCapturedAt: latest,
      funnel: MEME_STAGES.map((stage) => ({ stage, count: newest.filter((row) => row.stage === stage).length })),
      cohort: { firstSeenInWindow: denominator, graduatedInWindow: numerator },
      graduationRate: denominator > 0 ? numerator / denominator : null,
      timeToGraduate: hours.length
        ? { median: percentile(hours, 0.5), p25: percentile(hours, 0.25), p75: percentile(hours, 0.75), sample: hours.length }
        : null,
    }
  }).sort((a, b) => b.contracts - a.contracts || a.key.localeCompare(b.key))
}

/** Every row of a snapshot the page lists, with the provenance and the
 * launchpad facts on the row itself so a list item never needs a second read. */
const listRow = (row: Row) => ({
  chain: row.chain, contractAddress: row.contractAddress, symbol: row.symbol, name: row.name,
  marketCap: row.marketCap, firstSeenAt: row.firstSeenAt,
  source: row.source, launchpad: row.launchpad, launchpadLabel: row.launchpad ? PAD_LABELS[row.launchpad] ?? null : null,
  graduationPct: row.graduationPct, completedAt: row.completedAt, migrationPool: row.migrationPool, fdv: row.fdv,
})

/**
 * The meme graduation funnel, cohort rate, time-to-graduate distribution and
 * retention for one window, optionally for one chain.
 */
// deno-lint-ignore no-explicit-any
export async function readMemeGraduation(db: any, params: { days?: unknown; chain?: unknown; launchpad?: unknown; source?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = Math.trunc(Number(params.days))
  const days = MEME_DAYS.includes(requested) ? requested : 7
  const chain = str(params.chain, 60)
  // Filters are applied in the DATABASE, not after the row cap, so a filtered
  // window is the newest SNAPSHOT_CAP rows OF THAT FILTER rather than whatever
  // survived a cap applied to everything.
  const launchpad = str(params.launchpad, 120)
  const source = str(params.source, 40)
  const nowMs = at(now), windowStart = new Date(nowMs - days * 86_400_000).toISOString()
  const empty = (reason: string | null): ViewResult => ({
    view: 'meme_graduation', days, chain, launchpad, source, funnel: [], graduationRate: null,
    cohort: { firstSeenInWindow: 0, graduatedInWindow: 0 },
    timeToGraduate: null, retention: [], recent: [], launchpads: [], chains: [], sources: [],
    captures: 0, attribution: COINGECKO_ATTRIBUTION, asOf: null, coverage: emptyCoverage(), reason,
  })

  const snapshots = await readRows(() => {
    let q = db.from('intel_meme_stage_snapshots').select(SNAPSHOT_COLUMNS).gte('captured_at', windowStart)
    if (chain) q = q.eq('chain', chain)
    if (launchpad) q = q.eq('launchpad', launchpad)
    if (source) q = q.eq('source', source)
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
      contracts: capByEntity(members, { entityOf: platformOf, perEntity: FUNNEL_PER_PLATFORM, limit: FUNNEL_CONTRACTS, overflow: 'backfill' }).rows.map(listRow),
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
    if (launchpad) q = q.eq('launchpad', launchpad)
    if (source) q = q.eq('source', source)
    return q.order('at', { ascending: false }).limit(TRANSITION_CAP)
  })
  const graduations = moves.rows.map(moveRow).filter((row): row is Move => !!row)
  const hours = graduations.map((row) => row.hours).filter((v): v is number => v != null && v >= 0).sort((a, b) => a - b)
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
  const newestSightings: Row[] = []
  for (const row of rows) {
    const key = `${row.chain}|${row.contractAddress}`
    if (seenContract.has(key)) continue
    seenContract.add(key)
    newestSightings.push(row)
    if (newestSightings.length >= RECENT_CANDIDATES) break
  }
  const recent: Record<string, unknown>[] = capWithinRuns(newestSightings, (row) => row.capturedAt, { entityOf: platformOf, perEntity: RECENT_PER_PLATFORM })
    .rows.slice(0, RECENT_MAX).map((row) => ({ ...listRow(row), stage: row.stage, capturedAt: row.capturedAt }))

  // ── per-launchpad and per-chain, and which lane wrote what ──
  const windowStartMs = Date.parse(windowStart)
  const launchpads = groupStats(rows, graduations, asOf, windowStartMs,
    (row) => row.launchpad, (move) => move.launchpad,
    (key) => PAD_LABELS[key] ?? key, (key) => PAD_CHAINS[key] ?? null)
  const chains = groupStats(rows, graduations, asOf, windowStartMs,
    (row) => row.chain, (move) => move.chain,
    (key) => CHAIN_LABELS[key] ?? key, (key) => key)
  const sources = [...new Set(rows.map((row) => row.source))].sort().map((name) => {
    const mine = rows.filter((row) => row.source === name)
    return { source: name, latestCapturedAt: mine.map((row) => row.capturedAt).sort().at(-1) ?? null, rows: mine.length }
  })

  return {
    view: 'meme_graduation', days, chain, launchpad, source,
    funnel, graduationRate,
    cohort: { firstSeenInWindow: denominator, graduatedInWindow: numerator },
    timeToGraduate, retention, recent,
    launchpads, chains, sources,
    // How many distinct capture hours the window holds. Every figure derived
    // from movement (a transition, a graduation rate, a time to graduate) needs
    // more than one of them before it exists, so the page can say "not yet"
    // instead of drawing a zero.
    captures: new Set(rows.map((row) => row.capturedAt)).size,
    // Required wherever this data is shown; see the header.
    attribution: COINGECKO_ATTRIBUTION,
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
