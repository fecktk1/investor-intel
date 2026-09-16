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
