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
/** 'inspected' is the cohort the due-diligence budget actually reached, which is
 * a different question from 'flagged' (reached AND something was hit). Both
 * narrow the ROWS only: every `cohort` count below is measured over the whole
 * window before either filter, so narrowing the table never narrows the claim
 * the summary line makes about the window. */
const LISTING_STATUSES = ['flagged', 'inspected', 'all']
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
/** Flag codes named in one side of a change. A document reports tens of items;
 * this only ever truncates a detail line, never a count. */
const FLAG_CODE_MAX = 20
/** Edges of the "change since first capture" distribution, in percent.
 *
 * The edges are FIXED and published here rather than derived from the day's
 * cohort, so the same bar means the same thing on every window and on every
 * capture day. -100 is the floor a price change cannot pass, which also lets the
 * figure draw its zero crossing; the top bin is open ended because a new listing
 * can and does multiply. */
const SINCE_BINS: Array<[number, number | null]> = [
  [-100, -50], [-50, -25], [-25, -10], [-10, 0], [0, 10], [10, 25], [25, 50], [50, null],
]

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

/** Percent change between the OLDEST and the NEWEST captured price this window
 * holds for one asset.
 *
 * This is a reading of OUR capture, not of the listing: the daily run began on
 * 2026-09-15 and an asset the provider added before that was already trading
 * when we first saw it. So the claim is "since the first price this capture
 * recorded", and it needs two captures to exist at all — one snapshot is a
 * single observation, never a move. A first price of zero or below has no
 * percentage to report and returns null rather than an infinity. */
export function sinceCapture(first: unknown, last: unknown): number | null {
  const from = num(first), to = num(last)
  if (from == null || to == null || from <= 0) return null
  return ((to - from) / from) * 100
}

/** The codes the provider marked as HIT in one flag document, sorted so two
 * documents can be compared without their item order mattering. */
export function hitCodes(security: unknown): string[] {
  const doc = security && typeof security === 'object' && !Array.isArray(security) ? security as Record<string, unknown> : null
  if (!doc || !Array.isArray(doc.items)) return []
  // deno-lint-ignore no-explicit-any
  return [...new Set((doc.items as any[]).filter((item) => item?.hit === true).map((item) => str(item?.code, 120)).filter((code): code is string => !!code))].sort()
}

/** Which reported hits differ between two flag documents.
 *
 * WHY THIS EXISTS BESIDE THE HASH. `changed` is a comparison of `security_hash`,
 * and a hash moves for anything inside the document — the provider rewording an
 * item's description moves it too. "Something changed" that a reader cannot act
 * on is not worth a row, so the board says WHICH hits appeared and which went
 * away, and says plainly when the hash moved and no hit did.
 *
 * Bounded: each list is capped, so a malformed document cannot widen the
 * payload, and the cap is a silent truncation of a detail line, never of a count. */
export function flagDelta(newest: unknown, previous: unknown): { added: string[]; removed: string[] } {
  const now = hitCodes(newest), before = hitCodes(previous)
  const beforeSet = new Set(before), nowSet = new Set(now)
  return {
    added: now.filter((code) => !beforeSet.has(code)).slice(0, FLAG_CODE_MAX),
    removed: before.filter((code) => !nowSet.has(code)).slice(0, FLAG_CODE_MAX),
  }
}

/** Whole days between the provider's own `date_added` and the newest capture of
 * this asset. Negative clock skew is clamped to zero: a listing cannot have been
 * on the provider for a negative number of days. */
export function daysOnProvider(dateAdded: unknown, asOf: unknown): number | null {
  const added = Date.parse(String(dateAdded ?? '')), seen = Date.parse(String(asOf ?? ''))
  if (!Number.isFinite(added) || !Number.isFinite(seen)) return null
  return Math.max(0, Math.floor((seen - added) / 86_400_000))
}

/** The fixed distribution, as counts on the published edges. Every bin is
 * returned even when it is empty: a missing bar reads as "no range here", which
 * is a different statement from "nothing landed in this range". */
export function sinceHistogram(values: number[]): Array<{ from: number; to: number | null; count: number }> {
  return SINCE_BINS.map(([from, to]) => ({
    from, to,
    count: values.filter((v) => Number.isFinite(v) && v >= from && (to == null || v < to)).length,
  }))
}

const LISTING_COLUMNS = 'provider_id,snapshot_date,symbol,name,slug,date_added,chain,contract_address,platform_name,platform_slug,platform_token_address,price,market_cap,self_reported_market_cap,fully_diluted_market_cap,circulating_supply,cmc_rank,volume_24h,change_24h_pct,holder_count,security,security_hash,security_state,captured_at'

// deno-lint-ignore no-explicit-any
const listingRow = (row: any) => ({
  providerId: str(row?.provider_id, 40), snapshotDate: str(row?.snapshot_date, 10),
  symbol: str(row?.symbol, 50), name: str(row?.name, 200), slug: str(row?.slug, 200),
  dateAdded: str(row?.date_added, 40),
  chain: str(row?.chain, 60), contractAddress: str(row?.contract_address, 200),
  // The provider's own platform, beside the verified identity and never folded
  // into it: `chain` still means "a chain the inspection lane can act on".
  platformName: str(row?.platform_name, 120), platformSlug: str(row?.platform_slug, 120),
  platformTokenAddress: str(row?.platform_token_address, 200),
  price: num(row?.price), marketCap: num(row?.market_cap),
  selfReportedMarketCap: num(row?.self_reported_market_cap),
  fullyDilutedMarketCap: num(row?.fully_diluted_market_cap),
  circulatingSupply: num(row?.circulating_supply), cmcRank: num(row?.cmc_rank),
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
      cohort: {
        count: 0, withContract: 0, withKnownChain: 0, inspected: 0, flagged: 0,
        medianHolderCount: null, medianVolume24h: null,
      },
      sinceListing: { sample: 0, excluded: 0, fell: 0, histogram: sinceHistogram([]) },
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
    // OLDEST captured price this window holds for the asset, which is not always
    // the oldest ROW: a capture day can record a null price.
    const priced = [...ordered].reverse().filter((row) => num(row.price) != null)
    // Two INSPECTED captures, or there is nothing to compare. A snapshot with no
    // hash is a capture nobody looked at, which is not evidence of anything.
    const comparable = !!(newest.securityHash && previous?.securityHash)
    const stamps = ordered.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
    const lastSeenAt = stamps.at(-1) ?? null
    return {
      providerId: newest.providerId, symbol: newest.symbol, name: newest.name, slug: newest.slug,
      dateAdded: newest.dateAdded, chain: newest.chain, contractAddress: newest.contractAddress,
      platformName: newest.platformName, platformSlug: newest.platformSlug, platformTokenAddress: newest.platformTokenAddress,
      price: newest.price, marketCap: newest.marketCap,
      selfReportedMarketCap: newest.selfReportedMarketCap, fullyDilutedMarketCap: newest.fullyDilutedMarketCap,
      circulatingSupply: newest.circulatingSupply, cmcRank: newest.cmcRank,
      volume24h: newest.volume24h, change24hPct: newest.change24hPct,
      holderCount: newest.holderCount, security: newest.security,
      securityState: newest.securityState, flagCount: flagCount(newest.security),
      firstSeenAt: stamps[0] ?? null, lastSeenAt,
      snapshots: ordered.length,
      daysOnProvider: daysOnProvider(newest.dateAdded, lastSeenAt),
      // Two PRICED captures or it does not exist. `firstPriceAt` names the clock
      // the percentage is measured from, so the figure never has to guess it.
      firstPrice: priced.length > 1 ? priced[0].price : null,
      firstPriceAt: priced.length > 1 ? priced[0].snapshotDate : null,
      sinceCapturePct: priced.length > 1 ? sinceCapture(priced[0].price, priced.at(-1)?.price) : null,
      changed: comparable && newest.securityHash !== previous?.securityHash,
      // WHY A STATE AND NOT JUST A BOOLEAN. `changed: false` answers two
      // different questions with one word: "we compared and nothing moved" and
      // "there was nothing to compare with". The second is the common one — a
      // contract inspected for the first time, or one the previous day's budget
      // never reached — and reporting it as "unchanged" would be a claim the
      // capture never made.
      changeState: !comparable ? 'first_inspection' : newest.securityHash !== previous?.securityHash ? 'changed' : 'unchanged',
      changedFlags: comparable && newest.securityHash !== previous?.securityHash
        ? { ...flagDelta(newest.security, previous?.security), since: previous?.snapshotDate ?? null }
        : null,
    }
  }).sort((a, b) => String(b.dateAdded ?? '').localeCompare(String(a.dateAdded ?? '')) || String(a.providerId).localeCompare(String(b.providerId)))

  const filtered = status === 'flagged'
    ? rows.filter((row) => (row.flagCount ?? 0) > 0)
    : status === 'inspected'
      ? rows.filter((row) => row.flagCount != null)
      : rows
  const shown = capWithinRuns(filtered, (row) => String(row.dateAdded ?? '').slice(0, 10), {
    entityOf: (row) => row.chain, perEntity: LISTINGS_PER_CHAIN_PER_DAY,
  }).rows.slice(0, LISTING_ROW_MAX)
  const stamps = all.map((row) => row.capturedAt).filter((v): v is string => !!v).sort()
  // Measured over the WHOLE window, before the status filter and before the
  // per-chain cap, so the summary describes the capture rather than the table.
  const moves = rows.map((row) => row.sinceCapturePct).filter((v): v is number => v != null)
  return {
    view: 'new_listings', days, status,
    // EVERY row is a link. The Markets asset page resolves any CoinMarketCap id
    // (verified live 2026-09-17: /intel/markets/MALA?...id=42311 and ARGUS id
    // 42308 both open in full while neither is in `market_assets`), so gating
    // the link on the local catalogue hid working pages behind plain text.
    rows: shown,
    cohort: {
      count: rows.length,
      // TWO different questions. `withContract` is the cohort the inspection
      // lane can act on (a contract on one of the four verified DEX chains);
      // `withKnownChain` is the cohort the provider named a chain for at all,
      // which is nearly all of them and is why the Chain column is no longer
      // mostly empty. Reporting only the first made the board look blinder than
      // the capture is.
      withContract: rows.filter((row) => !!row.contractAddress).length,
      withKnownChain: rows.filter((row) => !!row.platformName).length,
      inspected: rows.filter((row) => row.flagCount != null).length,
      flagged: rows.filter((row) => (row.flagCount ?? 0) > 0).length,
      medianHolderCount: medianOf(rows.map((row) => row.holderCount).filter((v): v is number => v != null)),
      medianVolume24h: medianOf(rows.map((row) => row.volume24h).filter((v): v is number => v != null)),
    },
    // A listing with one priced capture is EXCLUDED and counted as excluded; it
    // is never drawn at zero, which would read as "it did not move".
    sinceListing: {
      sample: moves.length,
      excluded: rows.length - moves.length,
      fell: moves.filter((v) => v < 0).length,
      histogram: sinceHistogram(moves),
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
