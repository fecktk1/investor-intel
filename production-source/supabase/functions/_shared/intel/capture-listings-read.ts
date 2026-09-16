// Investor Intel — read view over the new-listing due-diligence capture table
// (CMC plan proposal 21).
//
// Same contract as `capture-read.ts` and the Stage 3 read modules: pure functions
// over a PostgREST-shaped `db`, every read bounded by an explicit row cap,
// ordered newest-first so that hitting a cap loses the OLDEST rows, and
// `coverage` reporting the window actually read ({from, to, count}) with
// `truncated`. An empty table is an empty list with `asOf: null` — never an
// error, and never a fabricated row.
//
// The table is service-role only; this read runs inside the `intel-capture` Edge
// Function behind an authenticated Intel membership check.

import { capWithinRuns } from './feed-entity-cap.ts'

const LISTING_DAYS = [7, 30, 90]
const LISTING_STATUSES = ['flagged', 'all']
/** One row per listing per day. 100 listings x 90 days is the widest window the
 * view can be asked for, plus headroom for a day the provider listed more. */
const LISTING_CAP = 12_000
/** Rows returned to the caller. The capture universe is a 100-row page a day, so
 * this only ever binds when a long window carries many distinct assets. */
const LISTING_ROW_MAX = 500
/** Listings one chain may place ahead of the other chains added on the SAME day.
 *
 * ENTITY: the chain. A new-listing board is filled by launch waves, and a wave
 * is a chain event (a launchpad or bridge opening on one network), so a single
 * chain can own every row of a day while listings on other chains that day sit
 * below the fold. The issuer is not the right key: almost every new listing is
 * its own issuer, so an issuer cap would never bind.
 *
 * POLICY: defer, within the day. The board is ordered by the day the provider
 * added the asset and nobody chose that order, but a reader can see it, so rows
 * are only reordered among listings added on the same calendar day, where they
 * were tied anyway. No row is dropped, the cohort counts are computed before the
 * cap, and a day with one chain in it keeps its original order. */
const LISTINGS_PER_CHAIN_PER_DAY = 5

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const LISTING_VIEWS = ['new_listings'] as const
export type ListingView = typeof LISTING_VIEWS[number]

const num = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
const sinceDay = (now: Date | number, days: number): string => new Date(at(now) - days * 86_400_000).toISOString().slice(0, 10)
const emptyCoverage = (): Coverage => ({ from: null, to: null, count: 0 })

/** Bounded read. A failed read is reported as a reason on an empty result; the
 * caller renders "unavailable", never a silently short list. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** How many of the reported items the provider marked as hit. An item with an
 * unknown hit state is not counted, and a row with no security document at all
 * returns null — "not inspected" is never rendered as "no flags". */
export function flagCount(security: unknown): number | null {
  const doc = security && typeof security === 'object' && !Array.isArray(security) ? security as Record<string, unknown> : null
  if (!doc || !Array.isArray(doc.items)) return null
  // deno-lint-ignore no-explicit-any
  return (doc.items as any[]).filter((item) => item?.hit === true).length
}

/** Median of the values that exist. A cohort in which nothing was counted has no
 * median — null, not zero. */
export function medianOf(values: number[]): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!sorted.length) return null
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const LISTING_COLUMNS = 'provider_id,snapshot_date,symbol,name,slug,date_added,chain,contract_address,price,market_cap,volume_24h,change_24h_pct,holder_count,security,security_hash,security_state,captured_at'

// deno-lint-ignore no-explicit-any
const listingRow = (row: any) => ({
  providerId: str(row?.provider_id, 40), snapshotDate: str(row?.snapshot_date, 10),
  symbol: str(row?.symbol, 50), name: str(row?.name, 200), slug: str(row?.slug, 200),
  dateAdded: str(row?.date_added, 40),
  chain: str(row?.chain, 60), contractAddress: str(row?.contract_address, 200),
  price: num(row?.price), marketCap: num(row?.market_cap),
  volume24h: num(row?.volume_24h), change24hPct: num(row?.change_24h_pct),
  holderCount: num(row?.holder_count),
  security: row?.security && typeof row.security === 'object' && !Array.isArray(row.security) ? row.security as Record<string, unknown> : null,
  securityHash: str(row?.security_hash, 64),
  securityState: str(row?.security_state, 60),
  capturedAt: str(row?.captured_at, 40),
})

/** The newest snapshot of every asset listed inside the window, with the cohort
 * summary and a per-asset `changed` flag.
 *
 * `changed` compares the newest snapshot's `security_hash` against the PREVIOUS
 * snapshot of the SAME asset. It is false when the hashes match and false when
 * either side is missing: a row we could not inspect twice is not evidence that
 * anything changed. Two snapshots are required before it can ever be true, which
 * is the same rule `securityVersionChanges` applies to the research view. */
// deno-lint-ignore no-explicit-any
export async function readNewListings(db: any, params: { days?: unknown; status?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const requested = Math.trunc(Number(params.days))
  const days = LISTING_DAYS.includes(requested) ? requested : 7
  const asked = String(params.status ?? 'all').toLowerCase()
  const status = LISTING_STATUSES.includes(asked) ? asked : 'all'
  const page = await readRows(() => db.from('intel_new_listing_snapshots').select(LISTING_COLUMNS)
    .gte('snapshot_date', sinceDay(now, days)).order('snapshot_date', { ascending: false }).limit(LISTING_CAP))
  const all = page.rows.map(listingRow).filter((row) => !!row.providerId)
  if (!all.length) {
    return {
      view: 'new_listings', days, status, rows: [],
      cohort: { count: 0, withContract: 0, flagged: 0, medianHolderCount: null },
      asOf: null, coverage: emptyCoverage(), reason: page.reason,
    }
  }
  // Newest first per asset. The read is already ordered by snapshot_date desc, so
  // the first row of an asset is its newest and the second is the one before it.
  const byAsset = new Map<string, ReturnType<typeof listingRow>[]>()
  for (const row of all) byAsset.set(row.providerId as string, [...(byAsset.get(row.providerId as string) || []), row])

  const rows = [...byAsset.values()].map((history) => {
    const ordered = [...history].sort((a, b) => String(b.snapshotDate ?? '').localeCompare(String(a.snapshotDate ?? '')))
    const newest = ordered[0], previous = ordered[1] ?? null
    const stamps = ordered.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
    return {
      providerId: newest.providerId, symbol: newest.symbol, name: newest.name, slug: newest.slug,
      dateAdded: newest.dateAdded, chain: newest.chain, contractAddress: newest.contractAddress,
      price: newest.price, marketCap: newest.marketCap, volume24h: newest.volume24h, change24hPct: newest.change24hPct,
      holderCount: newest.holderCount, security: newest.security,
      securityState: newest.securityState, flagCount: flagCount(newest.security),
      firstSeenAt: stamps[0] ?? null, lastSeenAt: stamps.at(-1) ?? null,
      snapshots: ordered.length,
      changed: !!(newest.securityHash && previous?.securityHash && newest.securityHash !== previous.securityHash),
    }
  }).sort((a, b) => String(b.dateAdded ?? '').localeCompare(String(a.dateAdded ?? '')) || String(a.providerId).localeCompare(String(b.providerId)))

  const filtered = status === 'flagged' ? rows.filter((row) => (row.flagCount ?? 0) > 0) : rows
  const shown = capWithinRuns(filtered, (row) => String(row.dateAdded ?? '').slice(0, 10), {
    entityOf: (row) => row.chain, perEntity: LISTINGS_PER_CHAIN_PER_DAY,
  }).rows.slice(0, LISTING_ROW_MAX)
  const stamps = all.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
  return {
    view: 'new_listings', days, status, rows: shown,
    cohort: {
      count: rows.length,
      withContract: rows.filter((row) => !!row.contractAddress).length,
      flagged: rows.filter((row) => (row.flagCount ?? 0) > 0).length,
      medianHolderCount: medianOf(rows.map((row) => row.holderCount).filter((v): v is number => v != null)),
    },
    changed: rows.filter((row) => row.changed).length,
    asOf: stamps.at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: stamps.at(-1) ?? null, count: page.rows.length, truncated: page.rows.length >= LISTING_CAP },
    reason: page.reason,
  }
}

/** Integration surface. The reviewer wires these into the Edge Function's read
 * half alongside `readCaptureView`. */
export const LISTING_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  new_listings: (db, body, now) => readNewListings(db, body, now),
}
