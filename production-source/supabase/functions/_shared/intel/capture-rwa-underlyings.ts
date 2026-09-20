// Investor Intel: the RWA UNDERLYING REGISTRANT lane.
//
// ─── THE DISTINCTION THIS FILE EXISTS TO KEEP ────────────────────────────────
// A tokenised stock has TWO legal questions behind it, and they have different
// answers:
//
//   1. WHO ISSUED THE TOKEN? The firm that wraps the share and sells the wrapper.
//      That question is answered ONLY by a dated hand assertion in
//      rwa-issuer-aliases.ts, and its answers live in
//      intel_rwa_issuer_entities. Nothing in this file writes there.
//
//   2. WHAT IS UNDERNEATH IT? The listed company whose share is being wrapped.
//      CoinMarketCap publishes a `cik` on `/v5/real-world-assets/info` for
//      tokenised equities and ETFs, and that CIK is the UNDERLYING COMPANY's SEC
//      filer number (Nvidia's), not the token issuer's.
//
// Pouring those CIKs into the issuer tables would answer question 1 with the
// answer to question 2, which is exactly the class of mistake the alias map was
// written to prevent. So this lane models a SECOND, separately named thing: the
// underlying registrant. Its tables are new, its read view is new, and the
// issuer board is untouched.
//
// ─── PROVIDER-ASSERTED, AND LABELLED AS THAT ─────────────────────────────────
// "CoinMarketCap says this asset's underlying has CIK X" is recorded as exactly
// that: the provider, the field the value came from (`cik` on `rwaInfo`) and the
// capture time travel with every row, and the scope string on the profile says
// so in words. We then go and READ THAT CIK at EDGAR ourselves, which is our own
// primary-source observation, and we store the registrant's name next to the
// asset's name with a normalised comparison. A MISMATCH IS A FINDING AND IS
// SHOWN. We never upgrade a provider assertion into our own identity claim, and
// name similarity never maps anything.
//
// NOTHING EXPIRES ON A CLOCK. A profile is refreshed when the lane gets round to
// it, oldest first; an unrefreshed row stays true as of the capture time it
// carries. There is no review date and no deadline anywhere in this lane.
//
// ─── THREE OPS, EACH BOUNDED AND RESUMABLE ───────────────────────────────────
//   rwa_asset_map           Page `rwaMap` (a ZERO-CREDIT capability that had no
//                           caller) per asset type and store the whole universe
//                           in intel_rwa_asset_map, plus TRUE per-type counts
//                           for the UTC day in intel_rwa_asset_map_counts. The
//                           counts are a COUNT of enumerated ids, not a page
//                           length, so they do not stop at 250 the way a list
//                           page does. Credits: 0.
//
//   rwa_asset_profiles      Read `rwaInfo` in batches for assets WITH TOKENS,
//                           oldest-profiled first (never profiled first), and
//                           store the descriptive fields in
//                           intel_rwa_asset_profiles. Bounded to
//                           INFO_CALLS_PER_RUN batches of PROFILE_BATCH ids.
//                           Credits: at most INFO_CALLS_PER_RUN per run, once a
//                           day, so the whole universe is worked through over
//                           several days instead of in one burst.
//
//   rwa_underlying_registrants
//                           For each profile carrying a `cik`, read the EDGAR
//                           submissions JSON through the existing keyless EDGAR
//                           reader and store the registrant's name, SIC, state,
//                           fiscal year end and its latest annual, quarterly and
//                           current-report filings. Credits: 0. EDGAR's ceiling
//                           is 10 requests a second; this op is far gentler (see
//                           EDGAR_SPACING_MS) and stops starting reads at its
//                           own wall-clock guard.
//
// NEVER THROWS. Every failure becomes a named reason on the JobResult, and a
// source that failed never empties a table: the writes are upserts keyed so a
// retry lands on the same row.

import { RWA_ASSET_TYPES, utcDate } from './capture-jobs.ts'
import type { CaptureDeps, JobResult, SchedulePolicyRow } from './capture-jobs.ts'
import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import { edgarFilerUrl, fetchSubmissions } from './rwa-sources/edgar.ts'
import type { SubmissionsRecord } from './rwa-sources/edgar.ts'
import { resolveEdgarUserAgent } from './rwa-sources/edgar-agent.ts'
import type { SourceDeps } from './rwa-sources/http.ts'

/** The universe enumeration and the descriptive profiles answer to the
 * CoinMarketCap provider row, like every other credit-spending lane. */
export const UNDERLYING_CMC_PROVIDER = 'coinmarketcap'
/** The EDGAR half answers to the same keyless provider row as the issuer lane. */
export const UNDERLYING_EDGAR_PROVIDER = 'primary-sources'

export const MAP_FEATURE = 'rwa_asset_map'
export const PROFILE_FEATURE = 'rwa_asset_profiles'
export const REGISTRANT_FEATURE = 'rwa_underlying_registrants'

export const MAP_TABLE = 'intel_rwa_asset_map'
export const MAP_COUNT_TABLE = 'intel_rwa_asset_map_counts'
export const PROFILE_TABLE = 'intel_rwa_asset_profiles'
export const REGISTRANT_TABLE = 'intel_rwa_underlying_registrants'

/** The pg_cron jobs that fill these tables (UTC). Served by the read view so an
 * empty board can say when it fills; asserted against the migration by test. */
export const RWA_UNDERLYING_CAPTURE_SCHEDULE = {
  rwa_asset_map: { job: 'intel-capture-rwa-asset-map-daily', cron: '11 3 * * *', cadence: 'daily', utc: '03:11' },
  rwa_asset_profiles: { job: 'intel-capture-rwa-asset-profiles-daily', cron: '29 3 * * *', cadence: 'daily', utc: '03:29' },
  rwa_underlying_registrants: { job: 'intel-capture-rwa-underlying-registrants-daily', cron: '47 3 * * *', cadence: 'daily', utc: '03:47' },
} as const

/** `rwaMap` rows per page. `cmcRows` keeps at most 250 rows from any registry
 * response, so asking for more would silently drop the tail. */
export const MAP_PAGE = 250
/** Pages per asset type. Six types times four pages is a 6,000 asset ceiling at
 * zero credits; a type that answers a short page stops early. */
export const MAP_PAGES_PER_TYPE = 4

/** Ids per `rwaInfo` call. Fifty is deliberately below the hundred-item bucket
 * the provider bills metadata in, so one call is one credit however the account
 * is metered, and the URL stays short. */
export const PROFILE_BATCH = 50
/** Batches per run. THE CREDIT CEILING OF THIS LANE: at most 12 calls a day,
 * which the registry's own cost model prices at 12 credits (rwaInfo is billed
 * per 250 ids, so ceil(50/250) = 1 each). Twelve a day is two orders of
 * magnitude below the daily budget, and 600 profiles a run works through a
 * universe of a few thousand assets in under a week. */
export const INFO_CALLS_PER_RUN = 12

/** EDGAR reads one run will start. The wall-clock guard below usually binds
 * first on a filer with a long `recent` block. */
export const REGISTRANTS_PER_RUN = 25
/** Spacing between EDGAR reads, on top of the 150 ms floor the shared transport
 * already enforces. EDGAR documents ten requests a second; this is under two a
 * second, which is what "far gentler" has to mean in a number. */
export const EDGAR_SPACING_MS = 600
/** The op stops STARTING EDGAR reads after this much wall clock, so a run
 * against filers with large submission documents ends inside the Edge Function
 * budget and the next run resumes where it stopped. */
export const EDGAR_WALL_CLOCK_MS = 55_000

/** Annual, quarterly and current reports, by EDGAR form name. Amendments count:
 * a 10-K/A is the filer's newest annual statement of the same period, and
 * treating it as "not an annual report" would age a current filer on purpose.
 * Foreign private issuers file 20-F and 40-F annually and 6-K as their current
 * report, and a tokenised ADR is exactly the case that needs them. */
export const ANNUAL_FORMS = ['10-K', '10-K/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A'] as const
export const QUARTERLY_FORMS = ['10-Q', '10-Q/A', '10-QT', '10-QT/A'] as const
export const CURRENT_FORMS = ['8-K', '8-K/A', '6-K', '6-K/A'] as const
export const PERIODIC_FORMS = [...ANNUAL_FORMS, ...QUARTERLY_FORMS, ...CURRENT_FORMS] as const

/** What the profile row's scope string says, in the schema's own words. A row
 * without it is refused, because a CIK shown without saying whose it is invites
 * exactly the confusion this lane is built around. */
export const PROFILE_SCOPE =
  'Descriptive fields as CoinMarketCap published them for this tokenised asset, captured at the time on this row. Where a filer number (CIK) is present it is the SEC filer number of the UNDERLYING LISTED COMPANY as the provider asserts it, not of the firm that issued the token, and it is recorded as a provider assertion rather than as our own verified identity. Nothing here establishes who issued the token, and nothing here is advice.'

/** And what the registrant row's scope string says. */
export const REGISTRANT_SCOPE =
  'Read by us from the SEC EDGAR submissions record for the filer number CoinMarketCap asserts for this asset\'s underlying company. The filing dates and accession numbers are EDGAR\'s; the name comparison is ours and is an exact comparison of normalised strings, never a similarity score. A name that differs is reported as differing: it may mean the provider\'s filer number belongs to a different company, or simply that the asset is named after a ticker rather than a registered legal name. Neither this row nor the comparison identifies who issued the token.'

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const int = (v: unknown): number | null => { const n = num(v); return n == null ? null : Math.trunc(n) }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const day = (v: unknown): string | null => { const s = String(v ?? '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null }
const iso = (v: unknown): string | null => { const parsed = Date.parse(String(v ?? '')); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null)

/** This lane's own policy rows. `schedulePolicy` in capture-jobs.ts filters on
 * the CoinMarketCap provider, so it would not see the EDGAR op's row. */
export function underlyingPolicy(policy: SchedulePolicyRow[] | undefined, feature: string, provider: string): { enabled: boolean } {
  const row = (policy || []).find((r) => r?.feature === feature && r.provider === provider)
  return { enabled: row ? row.enabled !== false : true }
}

// deno-lint-ignore no-explicit-any
async function upsert(db: any, table: string, rows: Record<string, unknown>[], onConflict: string): Promise<{ rows: number; error?: string }> {
  if (!rows.length) return { rows: 0 }
  try {
    const { error } = await db.from(table).upsert(rows, { onConflict })
    if (error) return { rows: 0, error: String(error.message || error).slice(0, 200) }
    return { rows: rows.length }
  } catch (e) { return { rows: 0, error: ((e as Error)?.message || 'write_failed').slice(0, 200) } }
}

// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/**
 * The name comparison, and the ONLY comparison this lane performs.
 *
 * Normalisation is case folding plus the removal of every character that is not
 * a letter or a digit, so "NVIDIA CORP" and "Nvidia Corp." normalise alike and
 * "NVIDIA CORPORATION" does not become "NVIDIA CORP". Both raw strings and both
 * normalised strings are stored, so a reader can reproduce the verdict.
 *
 *   exact      the normalised strings are identical
 *   contained  one normalised string is a substring of the other. This is
 *              CONTAINMENT, not identity: it is reported as what it is and never
 *              treated as a mapping.
 *   differs    both names are known and neither contains the other
 *   unknown    one side is missing, so nothing was compared
 *
 * There is no score, no distance and no threshold, and there never may be: the
 * issuer alias map exists because a similarity presented as a fact is a legal
 * problem. See rwa-issuer-aliases.ts.
 */
export type NameMatch = 'exact' | 'contained' | 'differs' | 'unknown'

export function normalizeName(value: unknown): string | null {
  const s = String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
  return s ? s : null
}

export function compareNames(registrantName: unknown, assetName: unknown): { match: NameMatch; registrant: string | null; asset: string | null } {
  const registrant = normalizeName(registrantName)
  const asset = normalizeName(assetName)
  if (!registrant || !asset) return { match: 'unknown', registrant, asset }
  if (registrant === asset) return { match: 'exact', registrant, asset }
  // A one or two character normalised name would be contained in almost
  // anything, so containment is only claimed once there is enough of it to mean
  // something. Below that the honest answer is that the names differ.
  if (asset.length >= 3 && (registrant.includes(asset) || asset.includes(registrant))) return { match: 'contained', registrant, asset }
  return { match: 'differs', registrant, asset }
}

/** The newest filing of a given form family, by EDGAR's own filing date. */
export function latestFiling(record: SubmissionsRecord | null, forms: readonly string[]): { form: string; filingDate: string | null; accessionNumber: string } | null {
  const wanted = new Set(forms)
  const rows = (record?.filings ?? []).filter((f) => wanted.has(f.form) && !!f.accessionNumber)
  if (!rows.length) return null
  rows.sort((a, b) => String(b.filingDate ?? '').localeCompare(String(a.filingDate ?? '')))
  const newest = rows[0]
  return { form: newest.form, filingDate: newest.filingDate, accessionNumber: newest.accessionNumber }
}

// ─── 1. The universe, at zero credits ────────────────────────────────────────

/**
 * Enumerate every RWA asset through `rwaMap` and store the true per-type counts.
 *
 * `rwaMap` is a zero-credit metadata capability that had no caller in this
 * codebase. It is paged PER ASSET TYPE rather than in one undifferentiated
 * sweep, so a row that omits its own `asset_type` still lands under the type it
 * was asked for and the counts cannot silently merge two types.
 */
export async function captureRwaAssetMap(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctx: MarketAssetsContext,
  now: Date,
  deps: CaptureDeps,
): Promise<JobResult> {
  const job = MAP_FEATURE
  try {
    if (!underlyingPolicy(deps.policy, MAP_FEATURE, UNDERLYING_CMC_PROVIDER).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const capturedAt = now.toISOString()
    const snapshotDate = utcDate(now)
    const reasons: Record<string, string> = {}
    let pages = 0
    let rows = 0
    // One entry per rwa id, so a duplicate across pages cannot double a count.
    const seen = new Map<number, Record<string, unknown>>()
    const counts = new Map<string, { assets: number; withTokens: number }>()

    for (const assetType of RWA_ASSET_TYPES) {
      let start = 1
      for (let page = 0; page < MAP_PAGES_PER_TYPE; page++) {
        const result = await deps.request('rwaMap', { asset_type: assetType, limit: MAP_PAGE, start }, ctx).catch(() => null)
        pages += 1
        if (!result?.payload) { reasons[assetType] = result?.reason || 'provider_unavailable'; break }
        const page_rows = cmcRows('rwaMap', result.payload).rows
        for (const row of page_rows) {
          const rwaId = int(row?.rwa_id ?? row?.id)
          if (rwaId == null || rwaId < 1) continue
          const type = text(row?.asset_type, 40) || assetType
          const hasTokens = bool(row?.has_tokens)
          if (!seen.has(rwaId)) {
            const bucket = counts.get(type) ?? { assets: 0, withTokens: 0 }
            bucket.assets += 1
            if (hasTokens === true) bucket.withTokens += 1
            counts.set(type, bucket)
          }
          seen.set(rwaId, {
            rwa_id: rwaId,
            slug: text(row?.slug, 120),
            symbol: text(row?.symbol, 40),
            name: text(row?.name, 300),
            asset_type: type,
            // `has_tokens` decides whether the profile op will ever ask about
            // this asset, so an absent field stays NULL rather than becoming a
            // false that would quietly drop it from the queue for good.
            has_tokens: hasTokens,
            rwa_rank: int(row?.rwa_rank),
            map_source: 'coinmarketcap:rwaMap',
            last_seen_at: capturedAt,
          })
        }
        // A short page is the end of the type. Nothing is inferred from a page
        // that failed: the loop above already broke out on that.
        if (page_rows.length < MAP_PAGE) break
        start += MAP_PAGE
      }
    }

    if (!seen.size) return { job, rows: 0, credits: 0, error: Object.values(reasons)[0] || 'provider_unavailable', pages }

    // Written in slices so one oversized statement cannot fail a whole run.
    const assets = [...seen.values()]
    for (let i = 0; i < assets.length; i += 500) {
      const write = await upsert(admin, MAP_TABLE, assets.slice(i, i + 500), 'rwa_id')
      if (write.error) return { job, rows, credits: 0, error: write.error, pages }
      rows += write.rows
    }

    // TRUE counts: a COUNT over enumerated ids, not the length of one list page.
    let allAssets = 0, allWithTokens = 0
    const countRows: Record<string, unknown>[] = []
    for (const [assetType, bucket] of counts) {
      allAssets += bucket.assets
      allWithTokens += bucket.withTokens
      countRows.push({
        asset_type: assetType, snapshot_date: snapshotDate,
        asset_count: bucket.assets, with_tokens_count: bucket.withTokens,
        map_source: 'coinmarketcap:rwaMap', captured_at: capturedAt,
      })
    }
    countRows.push({
      asset_type: 'all', snapshot_date: snapshotDate,
      asset_count: allAssets, with_tokens_count: allWithTokens,
      map_source: 'coinmarketcap:rwaMap', captured_at: capturedAt,
    })
    const countWrite = await upsert(admin, MAP_COUNT_TABLE, countRows, 'asset_type,snapshot_date')
    if (countWrite.error) return { job, rows, credits: 0, error: countWrite.error, pages }
    rows += countWrite.rows

    const reason = Object.entries(reasons).map(([type, why]) => `${type}:${why}`).join(' ')
    return { job, rows, credits: 0, pages, assets: assets.length, types: counts.size, ...(reason ? { partial: reason.slice(0, 200) } : {}) }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_asset_map_failed').slice(0, 200) }
  }
}

// ─── 2. Descriptive profiles, bounded and resumable ──────────────────────────

/**
 * The profile queue: assets NOT KNOWN TO LACK TOKENS, never profiled first, then
 * the stalest.
 *
 * `IS NOT FALSE` rather than `IS TRUE`, and the difference matters. `has_tokens`
 * is NULL when the `rwaMap` row did not carry the field. Filtering on `IS TRUE`
 * would then produce an empty queue for ever, and the lane would look enabled and
 * healthy while capturing nothing. Asking about an asset we have not been told
 * lacks tokens costs one id in a batch, and `rwaInfo` answers the question
 * authoritatively (its response does carry `has_tokens`), which is then stored on
 * the profile.
 *
 * `profiled_at` lives on the map table precisely so this is one indexed read
 * instead of a scan of two tables, and so a run resumes exactly where the
 * previous one stopped without a cursor anywhere in the code.
 */
// deno-lint-ignore no-explicit-any
export async function profileQueue(admin: any, limit: number): Promise<{ ids: number[]; reason: string | null }> {
  const read = await readRows(() => admin.from(MAP_TABLE).select('rwa_id,profiled_at')
    .not('has_tokens', 'is', false)
    .order('profiled_at', { ascending: true, nullsFirst: true })
    .order('rwa_id', { ascending: true })
    .limit(limit))
  // Sliced here too, not only in the query. A row ceiling that the database
  // applies differently from what was asked for would otherwise change this
  // lane's credit spend, and a credit ceiling has to hold in code.
  const ids = read.rows.map((r) => int(r?.rwa_id)).filter((v): v is number => v != null && v >= 1).slice(0, limit)
  return { ids, reason: read.reason }
}

export async function captureRwaAssetProfiles(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctx: MarketAssetsContext,
  now: Date,
  deps: CaptureDeps,
): Promise<JobResult> {
  const job = PROFILE_FEATURE
  try {
    if (!underlyingPolicy(deps.policy, PROFILE_FEATURE, UNDERLYING_CMC_PROVIDER).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const capturedAt = now.toISOString()
    const queue = await profileQueue(admin, INFO_CALLS_PER_RUN * PROFILE_BATCH)
    if (queue.reason) return { job, rows: 0, credits: 0, error: queue.reason }
    // An empty queue is a state, not a failure: the map op has not run yet, or
    // no asset in the universe reports tokens.
    if (!queue.ids.length) return { job, rows: 0, credits: 0, skipped: 'no_mapped_assets' }

    const reasons: Record<string, string> = {}
    let credits = 0, rows = 0
    const profiled: number[] = []

    for (let i = 0; i < queue.ids.length; i += PROFILE_BATCH) {
      const batch = queue.ids.slice(i, i + PROFILE_BATCH)
      const result = await deps.request('rwaInfo', { rwa_id: batch.join(',') }, ctx).catch(() => null)
      credits += 1
      if (!result?.payload) { reasons[`batch_${i / PROFILE_BATCH}`] = result?.reason || 'provider_unavailable'; continue }
      const providerFetchedAt = iso(result.provenance?.fetchedAt) ?? capturedAt
      const page = cmcRows('rwaInfo', result.payload).rows
      const profileRows: Record<string, unknown>[] = []
      for (const row of page) {
        const rwaId = int(row?.rwa_id ?? row?.id)
        if (rwaId == null || rwaId < 1) continue
        const about = row?.about && typeof row.about === 'object' ? row.about : {}
        profileRows.push({
          rwa_id: rwaId,
          provider: UNDERLYING_CMC_PROVIDER,
          provider_capability: 'rwaInfo',
          slug: text(row?.slug, 120),
          symbol: text(row?.symbol, 40),
          name: text(row?.name, 300),
          asset_type: text(row?.asset_type, 40),
          // The UNDERLYING company's filer number, as the provider asserts it.
          // `cik_field` records which provider field it came from, so the claim
          // stays attributable to a named field on a named capability.
          cik: cikDigits(row?.cik),
          cik_field: cikDigits(row?.cik) ? 'cik' : null,
          industry: text(row?.industry, 200),
          founded: text(row?.founded, 40),
          employees: int(row?.employees),
          primary_exchange: text(row?.primary_exchange, 120),
          rwa_rank: int(row?.rwa_rank),
          has_tokens: bool(row?.has_tokens),
          logo_url: httpsOnly(about?.logo),
          website: httpsOnly(about?.website ?? row?.website),
          description: text(about?.description, 20000),
          about_date_added: iso(about?.date_added),
          captured_at: capturedAt,
          provider_fetched_at: providerFetchedAt,
          scope: PROFILE_SCOPE,
        })
        profiled.push(rwaId)
      }
      const write = await upsert(admin, PROFILE_TABLE, profileRows, 'rwa_id')
      if (write.error) return { job, rows, credits, error: write.error }
      rows += write.rows
    }

    // Mark what was asked about, so the next run moves on even for an id the
    // provider answered nothing for. Without this a single unanswerable id would
    // sit at the head of the queue for ever and the lane would stall.
    const asked = queue.ids.slice(0, Math.min(queue.ids.length, INFO_CALLS_PER_RUN * PROFILE_BATCH))
    const stamp = asked.map((rwaId) => ({ rwa_id: rwaId, profiled_at: capturedAt }))
    for (let i = 0; i < stamp.length; i += 500) {
      const write = await upsert(admin, MAP_TABLE, stamp.slice(i, i + 500), 'rwa_id')
      if (write.error) { reasons.queue = write.error; break }
    }

    const reason = Object.entries(reasons).map(([where, why]) => `${where}:${why}`).join(' ')
    return { job, rows, credits, asked: asked.length, profiled: profiled.length, ...(reason ? { partial: reason.slice(0, 200) } : {}) }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_asset_profiles_failed').slice(0, 200) }
  }
}

/** Ten digits, zero padded, or null. A CIK arrives from the provider as a
 * number, a padded string or a 'CIK0000123456' string. */
export function cikDigits(value: unknown): string | null {
  const digits = String(value ?? '').trim().replace(/^CIK/i, '').replace(/\D/g, '')
  if (!digits || digits.length > 10 || Number(digits) < 1) return null
  return digits.padStart(10, '0')
}

/** A provider URL is stored only when it is plainly https. An http logo on an
 * https page is a broken image and a mixed-content warning, not a logo. */
export function httpsOnly(value: unknown): string | null {
  const s = text(value, 500)
  return s && /^https:\/\/[^\s]+$/i.test(s) ? s : null
}

// ─── 3. EDGAR, on our own clock and at our own pace ──────────────────────────

/** The registrant queue: profiles carrying a provider-asserted CIK, never
 * checked first, then the stalest. */
// deno-lint-ignore no-explicit-any
export async function registrantQueue(admin: any, limit: number): Promise<{ rows: { rwaId: number; cik: string; name: string | null; symbol: string | null }[]; reason: string | null }> {
  const read = await readRows(() => admin.from(PROFILE_TABLE).select('rwa_id,cik,name,symbol,registrant_checked_at')
    .not('cik', 'is', null)
    .order('registrant_checked_at', { ascending: true, nullsFirst: true })
    .order('rwa_id', { ascending: true })
    .limit(limit))
  const rows = read.rows
    .map((r) => ({ rwaId: int(r?.rwa_id), cik: cikDigits(r?.cik), name: text(r?.name, 300), symbol: text(r?.symbol, 40) }))
    .filter((r): r is { rwaId: number; cik: string; name: string | null; symbol: string | null } => r.rwaId != null && !!r.cik)
    // Sliced here too, so the per-run filer ceiling holds in code and not only in
    // the query.
    .slice(0, limit)
  return { rows, reason: read.reason }
}

export interface UnderlyingLaneDeps extends CaptureDeps { sources?: SourceDeps }

export async function captureRwaUnderlyingRegistrants(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: Date,
  deps: UnderlyingLaneDeps,
  options: { at?: number; startedAt?: number } = {},
): Promise<JobResult> {
  const job = REGISTRANT_FEATURE
  try {
    if (!underlyingPolicy(deps.policy, REGISTRANT_FEATURE, UNDERLYING_EDGAR_PROVIDER).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const at = options.at ?? now.getTime()
    const capturedAt = new Date(at).toISOString()
    const queue = await registrantQueue(admin, REGISTRANTS_PER_RUN)
    if (queue.reason) return { job, rows: 0, credits: 0, error: queue.reason }
    if (!queue.rows.length) return { job, rows: 0, credits: 0, skipped: 'no_asserted_ciks' }

    // An injected agent wins (tests, a manual run); otherwise the environment,
    // then the operating profile row. None resolves to `user_agent_required` at
    // the transport, BEFORE any EDGAR call is issued.
    const agent = deps.sources?.userAgent ?? (await resolveEdgarUserAgent(admin)).userAgent
    const sources: SourceDeps = { ...(deps.sources ?? {}), userAgent: agent }
    const sleep = sources.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const clock = sources.now ?? (() => Date.now())
    const deadline = (options.startedAt ?? clock()) + EDGAR_WALL_CLOCK_MS

    const reasons: Record<string, string> = {}
    // One EDGAR read per CIK, however many tokenised assets share it.
    const byCik = new Map<string, { rwaId: number; cik: string; name: string | null; symbol: string | null }[]>()
    for (const row of queue.rows) {
      const list = byCik.get(row.cik) ?? []
      list.push(row)
      byCik.set(row.cik, list)
    }

    let rows = 0, read = 0, stopped = false
    const checked: number[] = []
    const registrantRows: Record<string, unknown>[] = []

    for (const [cik, assets] of byCik) {
      if (read && clock() > deadline) { stopped = true; break }
      if (read) await sleep(EDGAR_SPACING_MS)
      const submissions = await fetchSubmissions(cik, sources, { forms: PERIODIC_FORMS, limit: 200 })
      read += 1
      if (submissions.reason) reasons.edgar = submissions.reason
      const record = submissions.record
      const annual = latestFiling(record, ANNUAL_FORMS)
      const quarterly = latestFiling(record, QUARTERLY_FORMS)
      const current = latestFiling(record, CURRENT_FORMS)
      for (const asset of assets) {
        const comparison = compareNames(record?.name, asset.name)
        registrantRows.push({
          rwa_id: asset.rwaId,
          cik,
          // 'known' means EDGAR answered with a readable filer record.
          // 'not_found' means EDGAR has no such filer, which is a finding about
          // the provider's assertion and must not look like a failed read.
          state: submissions.state,
          reason: submissions.reason ? text(submissions.reason, 120) : null,
          registrant_name: text(record?.name, 500),
          sic: text(record?.sic, 10),
          sic_description: text(record?.sicDescription, 200),
          state_of_incorporation: text(record?.stateOfIncorporation, 20),
          fiscal_year_end: text(record?.fiscalYearEnd, 8),
          exchanges: record?.exchanges?.length ? record.exchanges : null,
          tickers: record?.tickers?.length ? record.tickers : null,
          latest_annual_form: annual?.form ?? null,
          latest_annual_date: day(annual?.filingDate),
          latest_annual_accession: annual?.accessionNumber ?? null,
          latest_quarterly_form: quarterly?.form ?? null,
          latest_quarterly_date: day(quarterly?.filingDate),
          latest_quarterly_accession: quarterly?.accessionNumber ?? null,
          latest_current_form: current?.form ?? null,
          latest_current_date: day(current?.filingDate),
          latest_current_accession: current?.accessionNumber ?? null,
          filings_read: record?.filings?.length ?? 0,
          // Both raw names and both normalised names, so the verdict is
          // reproducible and a mismatch is legible rather than hidden.
          asset_name: asset.name,
          registrant_name_normalized: comparison.registrant,
          asset_name_normalized: comparison.asset,
          name_match: comparison.match,
          source_url: edgarFilerUrl(cik),
          fetched_at: submissions.fetchedAt,
          checked_at: capturedAt,
          scope: REGISTRANT_SCOPE,
        })
        checked.push(asset.rwaId)
      }
    }

    for (let i = 0; i < registrantRows.length; i += 200) {
      const write = await upsert(admin, REGISTRANT_TABLE, registrantRows.slice(i, i + 200), 'rwa_id')
      if (write.error) return { job, rows, credits: 0, error: write.error }
      rows += write.rows
    }

    // Advance the queue for everything we actually looked at, so the next run
    // moves on rather than re-reading the same filers for ever.
    const stamp = checked.map((rwaId) => ({ rwa_id: rwaId, registrant_checked_at: capturedAt }))
    for (let i = 0; i < stamp.length; i += 200) {
      const write = await upsert(admin, PROFILE_TABLE, stamp.slice(i, i + 200), 'rwa_id')
      if (write.error) { reasons.queue = write.error; break }
    }

    const reason = Object.entries(reasons).map(([where, why]) => `${where}:${why}`).join(' ')
    return {
      job, rows, credits: 0, ciks: read, assets: checked.length,
      ...(stopped ? { stopped: 'wall_clock' } : {}),
      ...(reason ? { partial: reason.slice(0, 200) } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_underlying_registrants_failed').slice(0, 200) }
  }
}

/** Lane ops, in the shape `intel-capture/index.ts` spreads into its runners. */
export const RWA_UNDERLYING_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => unknown,
  now: Date,
  plan: string,
  deps: UnderlyingLaneDeps,
  body: Record<string, unknown>,
) => Promise<JobResult>> = {
  // Six asset types times four pages, plus headroom for a retry inside the
  // transport. Zero credits either way: rwaMap is a zero-cost capability.
  rwa_asset_map: (admin, ctxFor, now, _plan, deps) =>
    captureRwaAssetMap(admin, ctxFor('rwa-asset-map', RWA_ASSET_TYPES.length * MAP_PAGES_PER_TYPE) as MarketAssetsContext, now, deps),
  rwa_asset_profiles: (admin, ctxFor, now, _plan, deps) =>
    captureRwaAssetProfiles(admin, ctxFor('rwa-asset-profiles', INFO_CALLS_PER_RUN) as MarketAssetsContext, now, deps),
  rwa_underlying_registrants: (admin, _ctxFor, now, _plan, deps) =>
    captureRwaUnderlyingRegistrants(admin, now, deps),
}
