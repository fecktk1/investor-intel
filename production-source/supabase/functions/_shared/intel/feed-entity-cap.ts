// One per-entity cap for every ranked board in Intel.
//
// Before this module the only diversity rule anywhere in the repo was the
// markets category board's row_number() window (20260914234442), so every other
// ranked feed could be filled end to end by a single asset, a single chain or a
// single story subject. This is that rule, written once.
//
// TWO overflow policies over ONE loop, because a board and a table want
// different things from the same cap:
//
//   'backfill'  a FIXED-SIZE board (top gainers, story cards, the signal radar).
//               Over-quota rows are set aside; if the in-quota rows do not fill
//               `limit`, the set-aside rows are added back in their original
//               order. A capped board is therefore NEVER shorter than the same
//               board would have been without the cap. That is the whole point:
//               a diversity rule that can empty a list is a failure mode, not a
//               feature.
//
//   'defer'     an OPEN-ENDED ranking (a paginated table). Nothing is dropped
//               and no total changes: over-quota rows move behind the in-quota
//               ones, so one entity cannot own the head of the ranking while
//               every row remains reachable on a later page.
//
// WHERE THE CAP IS DELIBERATELY NOT APPLIED. The rule inherited from the degen
// screener is that an ordering the reader explicitly chose is never reordered,
// and neither is a record of what a reader reviewed. Reviewed 2026-09-16:
//
//   markets screen table   every ordering is a column sort. The untouched default
//                          is market capitalisation, drawn as the active column
//                          header with a rank number on each row, so deferring a
//                          row would print ranks out of order under a header that
//                          says otherwise. Its derived boards (gainers, losers,
//                          category leaders) are capped in SQL.
//   intel-defi-browse      paginated in SQL and always sent with a sort; the
//                          default TVL order is drawn as the active TVL column.
//                          Reordering a page would contradict that header, and a
//                          per-page defer could not move a row to another page.
//   dex-cohort-service     a cohort is the exact membership a reader reviewed and
//                          captured, returned in the provider's own order, pinned
//                          to one platform and unique per contract. Reordering it
//                          would falsify the record it exists to keep.
//   adoption-attention     one asset compared with itself across two dated
//                          windows. It publishes no ranking of assets to cap.
//
// A row whose entity cannot be identified is never grouped with another such
// row. An unknown entity is not evidence that two rows share one, and treating
// every unnamed row as one entity would silently bury them all.

export type CapOverflow = 'backfill' | 'defer'

export interface EntityCapOptions<T> {
 /** The thing a board must not be filled by: an asset ref, a chain, a category,
  * a story subject. Compared case-insensitively after trimming. */
 entityOf: (row: T) => string | null | undefined
 /** How many rows one entity may hold. A value below one is treated as no cap
  * rather than as an instruction to empty the board. */
 perEntity: number
 /** Board size. Omitted means "as many as there are rows". */
 limit?: number
 overflow?: CapOverflow
}

export interface EntityCapResult<T> {
 rows: T[]
 /** Rows that exceeded their entity's quota. Under 'backfill' some of these may
  * still appear, which is what `backfilled` counts. */
 deferred: number
 /** How many over-quota rows were added back to avoid shipping a thin board. */
 backfilled: number
 /** Distinct entities seen, unnamed rows counted individually. */
 entities: number
}

/** Every real key is lower-cased before use, so an UPPERCASE sentinel cannot
 * collide with one however an entity is spelled. It is plain ASCII on purpose:
 * a non-printing sentinel character makes the whole file read as binary to git,
 * which costs every future reader the diff. */
const unnamedKey = (n: number) => `UNNAMED:${n}`

export function capByEntity<T>(rows: readonly T[] | null | undefined, options: EntityCapOptions<T>): EntityCapResult<T> {
 const all = Array.isArray(rows) ? rows.slice() : []
 const overflow: CapOverflow = options?.overflow === 'defer' ? 'defer' : 'backfill'
 const raw = Number(options?.perEntity)
 const cap = Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 0
 const requested = Number(options?.limit)
 const ceiling = options?.limit == null || !Number.isFinite(requested)
  ? all.length
  : Math.max(0, Math.min(Math.floor(requested), all.length))
 // No cap at all still honours the limit, so a caller can route every board
 // through this helper and keep one code path.
 if (!cap || typeof options?.entityOf !== 'function') return { rows: all.slice(0, ceiling), deferred: 0, backfilled: 0, entities: 0 }

 const used = new Map<string, number>()
 const kept: T[] = [], over: T[] = []
 let unnamed = 0
 for (const row of all) {
  let key: string
  try {
   const value = options.entityOf(row)
   key = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : unnamedKey(unnamed++)
  } catch {
   // A thrown accessor is a defect in the caller, never a reason to drop a row
   // from a board the reader was already going to see.
   key = unnamedKey(unnamed++)
  }
  const count = used.get(key) ?? 0
  if (count < cap) { used.set(key, count + 1); kept.push(row) } else over.push(row)
 }

 if (overflow === 'defer') return { rows: [...kept, ...over].slice(0, ceiling), deferred: over.length, backfilled: 0, entities: used.size }

 const head = kept.slice(0, ceiling)
 // The cap may not cost the board rows it would otherwise have shown. Whatever
 // the quota left short is filled from the set-aside rows, in rank order.
 const backfilled = Math.max(0, Math.min(ceiling - head.length, over.length))
 return { rows: [...head, ...over.slice(0, backfilled)], deferred: over.length, backfilled, entities: used.size }
}

/** The common case: a fixed-size board. Returns just the rows, so a call site
 * that only wants the list does not have to destructure. */
export function capRankedBoard<T>(rows: readonly T[] | null | undefined, options: EntityCapOptions<T>): T[] {
 return capByEntity(rows, { ...options, overflow: 'backfill' }).rows
}

/**
 * Defer over-quota rows INSIDE each contiguous run of rows that share an ordering
 * key, never across runs.
 *
 * Some default rankings carry an order a reader can see and rely on even though
 * nobody chose it: a list of listings by the day they were added, or of
 * contracts by the capture that sighted them. Moving a row behind a later day
 * would make that order false. Inside one day, or one capture, the rows are tied
 * on the only thing the list is ordered by, so their relative position is
 * arbitrary and a cap can spread entities without misstating anything.
 *
 * Nothing is dropped and the result is always the same length as the input:
 * every run keeps exactly its own rows, in the same run position.
 */
export function capWithinRuns<T>(
  rows: readonly T[] | null | undefined,
  runOf: (row: T) => string | null | undefined,
  options: Omit<EntityCapOptions<T>, 'limit' | 'overflow'>,
): EntityCapResult<T> {
  const all = Array.isArray(rows) ? rows.slice() : []
  const out: T[] = []
  let deferred = 0
  const entities = new Set<string>()
  let run: T[] = [], current: string | null = null
  const flush = () => {
    if (!run.length) return
    const capped = capByEntity(run, { ...options, overflow: 'defer' })
    out.push(...capped.rows)
    deferred += capped.deferred
    for (const row of run) {
      try { const e = options.entityOf(row); if (typeof e === 'string' && e.trim()) entities.add(e.trim().toLowerCase()) } catch { /* counted as unnamed by capByEntity */ }
    }
    run = []
  }
  for (const row of all) {
    let key: string
    try { key = String(runOf(row) ?? '') } catch { key = '' }
    if (current !== null && key !== current) flush()
    current = key
    run.push(row)
  }
  flush()
  return { rows: out, deferred, backfilled: 0, entities: entities.size }
}
