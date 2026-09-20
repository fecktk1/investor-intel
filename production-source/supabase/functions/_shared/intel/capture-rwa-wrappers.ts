// Investor Intel RWA wrapper spread capture lane.
//
// Same contract as the other capture lanes (`capture-listings.ts`,
// `capture-rwa-yield.ts`): one bounded function with an explicit call and credit
// ceiling, obeying `provider_schedule_policy`, never throwing (a failure becomes
// `{ error }`), and reaching CoinMarketCap only through the injected transport so
// the whole lane tests without a network or a database.
//
// WHAT ONE RUN DOES, AND WHAT IT COSTS.
//
//   1. ONE database read of the newest `intel_rwa_universe_snapshots` rows, to
//      learn which asset types the provider currently reports anything for and
//      which assets the universe lane already ranked. Zero credits.
//   2. ONE database read of this lane's own newest capture, so an asset that has
//      shown two or more wrappers before stays in the set even if it drops out
//      of a list page. Zero credits.
//   3. `/v5/real-world-assets/assets/list` once per selected asset type, sorted
//      by tokenised market cap, 250 rows. ceil(250/250) = 1 credit each, at most
//      RWA_WRAPPER_MAX_TYPES = 4 types, so at most 4 credits. This is ALSO the
//      list side of the two-endpoint reconciliation, so it is not an extra call.
//   4. `/v5/real-world-assets/map` once, only when a candidate from step 1 or 2
//      is missing from the list pages. The map is documented as costing NO
//      credit, so it resolves those identities for free.
//   5. `/v5/real-world-assets/quotes/latest` ONCE, with every candidate rwa_id
//      comma-joined. The endpoint bills ceil(n/250) and the set is capped at
//      RWA_WRAPPER_ASSET_CAP = 60, so this is exactly 1 credit.
//
//   Upper bound: 6 calls and 5 credits per run. At the six-hourly cadence below
//   that is 20 credits a day, against a Startup allowance measured in hundreds
//   of thousands a month.
//
// THE TWO CLOCKS. `captured_at` is the hour WE asked, floored, so a retried run
// inside one hour lands on the same primary key. `source_observed_at` is the
// provider's own USD quote clock, and `list_observed_at` is the same thing for
// the list endpoint. The reconciliation carries BOTH, because its whole subject
// is that two reads of the same provider disagree.
//
// HONESTY RULES THIS LANE KEEPS:
//   * A wrapper below the volume floor is stored, with its premium and with
//     `too_thin_to_anchor`. It is only kept out of the anchor.
//   * A wrapper whose unit could not be established is stored with
//     `unit_not_established` and no premium. It is never rescaled by guesswork.
//   * A wrapper that accrues its yield inside its price is stored with an
//     accrual gap and NO premium column value at all.
//   * An asset with fewer than two liquid wrappers has no anchor and carries the
//     reason. It is not given a median of one.
//   * A reconciliation the data cannot support is `not_comparable` with a
//     reason, never a ratio of 1.

import { hourBucket, iso, schedulePolicy, CAPTURE_PROVIDER, type CaptureDeps, type JobResult } from './capture-jobs.ts'
import { cmcRows, cmcObservedAt } from '../market-assets/cmc-capabilities.ts'
import type { MarketAssetsContext } from '../market-assets/types.ts'
import {
  wrapperAssetFromQuote, assetListFigures, wrapperSpread, reconcileTokenValue,
  RWA_NAV_ANCHORS, WRAPPER_SPREAD_SCOPE, LIQUIDITY_FLOOR_USD,
  RECONCILE_BAND_LOW, RECONCILE_BAND_HIGH,
  type AssetListFigures, type NavAnchorInput, type WrapperSpread,
} from './rwa-wrapper-spread.ts'

/** The pg_cron job that runs this lane (UTC), from migration
 * 20260920150000_intel_rwa_wrapper_spread.sql. Every six hours at minute 47,
 * forty minutes after the hourly `intel-capture` batch writes the RWA universe
 * row this lane reads its candidates from. Four reads a day is enough: a
 * premium between two wrappers of one asset moves on the same clock as the
 * underlying, and re-reading an unchanged token list hourly would spend four
 * times the credits for the same picture. Asserted against the migration by
 * test. */
export const RWA_WRAPPER_CAPTURE_SCHEDULE = {
  rwa_wrappers: { job: 'intel-capture-rwa-wrappers-6h', cron: '47 2,8,14,20 * * *', cadence: 'every_6_hours', utc: '02:47, 08:47, 14:47, 20:47' },
} as const

export const RWA_WRAPPER_FEATURE = 'rwa_wrappers'
export const ASSET_TABLE = 'intel_rwa_wrapper_assets'
export const TOKEN_TABLE = 'intel_rwa_wrapper_tokens'
export const UNIVERSE_TABLE = 'intel_rwa_universe_snapshots'
export const NAV_TABLE = 'intel_rwa_nav_observations'

/** How many rwa_ids one quotes call carries. The endpoint bills ceil(n/250), so
 * anything up to 250 is one credit; 60 keeps the response bounded and still
 * covers every multi-wrapper asset the universe currently reports. */
export const RWA_WRAPPER_ASSET_CAP = 60
/** Asset types read from the list endpoint per run. Measured 2026-09-20: only
 * `stock`, `commodity` and `etf` return any assets at all, so four is headroom
 * rather than a target. */
export const RWA_WRAPPER_MAX_TYPES = 4
/** Used only when the universe table is empty, so a first run still has a set. */
export const RWA_WRAPPER_DEFAULT_TYPES = ['stock', 'commodity', 'etf', 'government_security'] as const
/** Default cadence when the policy row carries none. */
export const RWA_WRAPPER_CADENCE_SECONDS = 21_600
const LIST_LIMIT = 250
const MAP_LIMIT = 250
const MAX_UPSERT_ROWS = 500
const UNIVERSE_ROWS = 14

export interface RwaWrapperDeps extends CaptureDeps {
  /** Overrides the volume floor for a test or a one-off operator run. */
  liquidityFloorUsd?: number
}

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const rwaId = (v: unknown): string | null => (/^[1-9][0-9]{0,11}$/.test(String(v ?? '')) ? String(v) : null)

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

/** Bounded read that never throws. A failed read degrades the run to a stated
 * reason; it never spends a credit blind and never ends the lane. */
// deno-lint-ignore no-explicit-any
async function readRows(build: () => any): Promise<{ rows: any[]; reason: string | null }> {
  try {
    const { data, error } = await build()
    if (error) return { rows: [], reason: String(error.message || error.code || error).slice(0, 200) }
    return { rows: Array.isArray(data) ? data : data ? [data] : [], reason: null }
  } catch (e) { return { rows: [], reason: ((e as Error)?.message || 'read_failed').slice(0, 200) } }
}

/** This lane's switch and cadence.
 *
 * `schedulePolicy` falls back to one hour for a feature it does not know, which
 * would run this lane four times more often than its cron and four times more
 * often than anyone approved. So the row's own `cadence_seconds` is read when it
 * carries one, and the documented six hours is the fallback otherwise. */
export function lanePolicy(deps: CaptureDeps): { enabled: boolean; cadenceSeconds: number } {
  const row = (deps.policy || []).find((r) => r?.feature === RWA_WRAPPER_FEATURE && (r.provider ?? CAPTURE_PROVIDER) === CAPTURE_PROVIDER)
  const cadence = Number(row?.cadence_seconds)
  return {
    enabled: schedulePolicy(deps.policy, RWA_WRAPPER_FEATURE).enabled,
    cadenceSeconds: Number.isFinite(cadence) && cadence > 0 ? cadence : RWA_WRAPPER_CADENCE_SECONDS,
  }
}

const callBudget = (ctx: MarketAssetsContext, ceiling: number): number => {
  const budget = Number(ctx?.maxCalls)
  return Math.max(0, Math.min(ceiling, Number.isFinite(budget) && budget >= 0 ? Math.trunc(budget) : ceiling))
}

// ─── Candidate selection ──────────────────────────────────────────────────────

export interface CandidateSeed {
  /** Asset types worth a list call, newest-capture first and deduplicated. */
  assetTypes: string[]
  /** rwa_ids the universe lane already ranked as the largest of their type. */
  universeIds: string[]
  reason: string | null
}

/** Which asset types the provider currently reports anything for, and which
 * assets the universe lane already ranked, read from the rows the hourly
 * `rwa` job wrote. Zero credits.
 *
 * Only `asset_type`, `asset_count` and `top_assets[].rwa_id` are read, all of
 * which are fixed by that table's own migration, so this survives any change to
 * how the universe lane computes its aggregates. A type reporting zero assets is
 * not called: paying a credit to be told again that there are no tokenised
 * currencies is a credit spent on nothing. */
// deno-lint-ignore no-explicit-any
export function candidateSeed(universeRows: any[]): CandidateSeed {
  const newest = universeRows
    .map((row) => text(row?.captured_at, 40))
    .filter((v): v is string => !!v).sort().at(-1) ?? null
  const rows = newest ? universeRows.filter((row) => text(row?.captured_at, 40) === newest) : []
  const types: string[] = []
  const ids: string[] = []
  const ranked = rows
    .filter((row) => text(row?.asset_type, 40) && text(row?.asset_type, 40) !== 'all')
    .sort((a, b) => (num(b?.total_market_value_usd) ?? -1) - (num(a?.total_market_value_usd) ?? -1))
  for (const row of ranked) {
    const type = text(row?.asset_type, 40)!
    if ((num(row?.asset_count) ?? 0) > 0 && !types.includes(type)) types.push(type)
  }
  // 'all' carries the largest assets across every type, so it is read for ids
  // even though it is never a list call.
  for (const row of rows) {
    for (const asset of (Array.isArray(row?.top_assets) ? row.top_assets : []).slice(0, 20)) {
      const id = rwaId(asset?.rwa_id)
      if (id && !ids.includes(id)) ids.push(id)
    }
  }
  return {
    assetTypes: types.length ? types.slice(0, RWA_WRAPPER_MAX_TYPES) : [...RWA_WRAPPER_DEFAULT_TYPES].slice(0, RWA_WRAPPER_MAX_TYPES),
    universeIds: ids,
    reason: newest ? null : 'universe_not_captured',
  }
}

/** Rank the candidate set.
 *
 * An asset this lane has ALREADY seen carrying two or more wrappers comes first:
 * it is the asset the surface exists for, and it must not fall out of the set
 * because a busier week pushed it down a list page. Everything else follows by
 * the list endpoint's own tokenised market cap, then by rwa_rank, then by id so
 * the set is deterministic for a given input.
 *
 * `has_tokens: false` is honoured wherever the provider reported it: an asset the
 * provider says has no tokens cannot have two wrappers. */
export function rankCandidates(
  figures: Map<string, AssetListFigures>,
  options: { sticky: string[]; universeIds: string[]; cap?: number },
): string[] {
  const cap = Math.max(1, Math.min(RWA_WRAPPER_ASSET_CAP, Math.trunc(Number(options.cap) || RWA_WRAPPER_ASSET_CAP)))
  const pool = new Set<string>([...options.sticky, ...options.universeIds, ...figures.keys()])
  const usable = [...pool].filter((id) => {
    const row = figures.get(id)
    return !row || row.hasTokens !== false
  })
  const stickyRank = new Map(options.sticky.map((id, index) => [id, index]))
  usable.sort((a, b) => {
    const sa = stickyRank.has(a) ? stickyRank.get(a)! : Number.MAX_SAFE_INTEGER
    const sb = stickyRank.has(b) ? stickyRank.get(b)! : Number.MAX_SAFE_INTEGER
    if (sa !== sb) return sa - sb
    const va = figures.get(a)?.tokenizedMarketCap ?? -1
    const vb = figures.get(b)?.tokenizedMarketCap ?? -1
    if (va !== vb) return vb - va
    const ra = figures.get(a)?.rwaRank ?? Number.MAX_SAFE_INTEGER
    const rb = figures.get(b)?.rwaRank ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return Number(a) - Number(b)
  })
  return usable.slice(0, cap)
}

// ─── Row builders ─────────────────────────────────────────────────────────────

/** One asset row, carrying both endpoints' figures and both endpoints' clocks. */
export function assetRow(
  spread: WrapperSpread,
  list: AssetListFigures | null,
  context: { capturedAt: string; listCapturedAt: string | null; listObservedAt: string | null; fetchedAt: string; floor: number },
): Record<string, unknown> {
  const reconciliation = reconcileTokenValue({
    listMarketCap: list?.tokenizedMarketCap ?? null,
    listCapturedAt: context.listCapturedAt,
    listObservedAt: list?.observedAt ?? null,
    tokenMarketCapSum: spread.tokenMarketCapSum,
    quotesCapturedAt: context.capturedAt,
    quotesObservedAt: spread.observedAt,
  })
  return {
    provider: CAPTURE_PROVIDER, rwa_id: spread.rwaId, captured_at: context.capturedAt,
    symbol: spread.symbol, name: spread.name, asset_type: spread.assetType, rwa_rank: spread.rwaRank,
    // ── the anchor ──
    anchor_kind: spread.anchorKind, anchor_price: spread.anchorPrice,
    anchor_feed_key: spread.anchorFeedKey, anchor_observed_at: iso(spread.anchorObservedAt),
    anchor_reason: spread.anchorReason, anchor_members: spread.anchorMembers,
    // ── the wrappers ──
    wrapper_count: spread.wrapperCount, liquid_count: spread.liquidCount, thin_count: spread.thinCount,
    accrual_count: spread.accrualCount,
    unit_normalised_count: spread.unitNormalisedCount, unit_refused_count: spread.unitRefusedCount,
    weight_denominated: spread.weightDenominated,
    volume_floor_usd: context.floor,
    // ── the figures ──
    widest_premium_bps: spread.widestPremiumBps, widest_premium_crypto_id: spread.widestPremiumCryptoId,
    widest_discount_bps: spread.widestDiscountBps, widest_discount_crypto_id: spread.widestDiscountCryptoId,
    dispersion_bps: spread.dispersionBps, weighted_spread_bps: spread.weightedSpreadBps,
    cheapest_crypto_id: spread.cheapestCryptoId, cheapest_premium_bps: spread.cheapestPremiumBps,
    // ── the quotes endpoint's own asset-level figures ──
    average_tokenized_price: spread.averageTokenizedPrice,
    tokenized_market_cap: spread.tokenizedMarketCap,
    tokenized_volume_24h: spread.tokenizedVolume24h,
    source_observed_at: iso(spread.observedAt),
    // ── the list endpoint, and the reconciliation between the two ──
    list_tokenized_market_cap: reconciliation.listMarketCap,
    list_tokenized_volume_24h: list?.tokenizedVolume24h ?? null,
    list_average_tokenized_price: list?.averageTokenizedPrice ?? null,
    list_captured_at: reconciliation.listCapturedAt,
    list_observed_at: iso(reconciliation.listObservedAt),
    token_market_cap_sum: reconciliation.tokenMarketCapSum,
    token_market_cap_reported: spread.tokenMarketCapReported,
    reconcile_state: reconciliation.state, reconcile_ratio: reconciliation.ratio,
    reconcile_gap_usd: reconciliation.gapUsd, reconcile_reason: reconciliation.reason,
    reconcile_band_low: RECONCILE_BAND_LOW, reconcile_band_high: RECONCILE_BAND_HIGH,
    fetched_at: context.fetchedAt, scope: WRAPPER_SPREAD_SCOPE,
  }
}

/** One wrapper row. `premium_bps` and `accrual_gap_bps` are separate columns on
 * purpose: nothing downstream can render an accrual as a premium by reading the
 * wrong field, and the database enforces that only one of them is ever set. */
export function tokenRows(spread: WrapperSpread, context: { capturedAt: string; fetchedAt: string }): Record<string, unknown>[] {
  return spread.tokens.map((row) => ({
    provider: CAPTURE_PROVIDER, rwa_id: spread.rwaId, crypto_id: row.cryptoId, captured_at: context.capturedAt,
    symbol: row.symbol, name: row.name, issuer_id: row.issuerId, issuer_name: row.issuerName,
    price: row.price, normalised_price: row.normalisedPrice,
    market_cap: row.marketCap, volume_24h: row.volume24h,
    unit_state: row.unitState, unit_factor: row.unitFactor,
    wrapper_state: row.state, premium_bps: row.premiumBps, accrual_gap_bps: row.accrualGapBps,
    in_anchor: row.inAnchor, state_reason: row.reason,
    fetched_at: context.fetchedAt,
  }))
}

// ─── The lane ─────────────────────────────────────────────────────────────────

/** Capture the wrapper spread and the two-endpoint reconciliation for a bounded
 * set of tokenised assets.
 *
 * Returns what the run DID. Nothing here promises a figure is correct: an asset
 * with no anchor, a wrapper with no established unit and a reconciliation the
 * data cannot support each occupy a row carrying its own reason. */
export async function captureRwaWrappers(
  // deno-lint-ignore no-explicit-any
  admin: any,
  ctxFor: (name: string, maxCalls: number) => MarketAssetsContext,
  now: Date,
  deps: RwaWrapperDeps,
): Promise<JobResult> {
  const job = 'rwa_wrappers'
  const capturedAt = hourBucket(now)
  const fetchedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
  let credits = 0
  try {
    const policy = lanePolicy(deps)
    if (!policy.enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    const cadenceSeconds = policy.cadenceSeconds

    // ── 1 and 2. Two zero-credit database reads. A failure here narrows the
    //    candidate set to what the list pages give and is reported as a partial;
    //    it never ends the run and never spends a credit blind.
    const [universe, previous] = await Promise.all([
      readRows(() => admin.from(UNIVERSE_TABLE).select('asset_type,captured_at,asset_count,total_market_value_usd,top_assets')
        .order('captured_at', { ascending: false }).limit(UNIVERSE_ROWS)),
      readRows(() => admin.from(ASSET_TABLE).select('rwa_id,captured_at,wrapper_count')
        .order('captured_at', { ascending: false }).limit(RWA_WRAPPER_ASSET_CAP * 2)),
    ])

    // The cadence guard reads this lane's OWN newest capture, from the same read
    // that supplies the sticky set: one query, two uses.
    const newestOwn = previous.rows.map((row) => text(row?.captured_at, 40)).filter((v): v is string => !!v).sort().at(-1) ?? null
    const newestMs = newestOwn ? Date.parse(newestOwn) : NaN
    if (Number.isFinite(newestMs) && (now.getTime() - newestMs) < cadenceSeconds * 1000 * 0.9) {
      return { job, rows: 0, credits: 0, skipped: 'within_cadence', newestAt: newestOwn }
    }

    const seed = candidateSeed(universe.rows)
    // Assets this lane already proved carry two or more wrappers, newest capture
    // only, ordered by how many wrappers they had.
    const sticky = previous.rows
      .filter((row) => text(row?.captured_at, 40) === newestOwn && (num(row?.wrapper_count) ?? 0) >= 2)
      .sort((a, b) => (num(b?.wrapper_count) ?? 0) - (num(a?.wrapper_count) ?? 0))
      .map((row) => rwaId(row?.rwa_id)).filter((v): v is string => !!v)

    const ceiling = RWA_WRAPPER_MAX_TYPES + 2
    const ctx = ctxFor('rwa-wrappers', ceiling)
    const budget = callBudget(ctx, ceiling)
    if (budget < 2) return { job, rows: 0, credits: 0, skipped: 'call_budget' }

    let calls = 0
    let partial: string | null = universe.reason ? 'universe_read_failed' : previous.reason ? 'previous_read_failed' : seed.reason

    // ── 3. The list endpoint, once per selected asset type. This is both the
    //    candidate source and the list side of the reconciliation.
    const figures = new Map<string, AssetListFigures>()
    let listObservedAt: string | null = null
    for (const assetType of seed.assetTypes) {
      // One call must stay in hand for the quotes read, which is the whole point
      // of the run; a list page is only its input.
      if (calls + 2 > budget) { partial = partial || 'call_budget'; break }
      const result = await deps.request('rwaList', { asset_type: assetType, limit: LIST_LIMIT, start: 1, sort: 'tokenized_market_cap', sort_dir: 'desc' }, ctx).catch(() => null)
      calls += 1
      credits += 1
      if (!result?.payload) { partial = partial || text(result?.reason, 60) || 'list_unavailable'; continue }
      for (const row of cmcRows('rwaList', result.payload).rows) {
        const parsed = assetListFigures(row)
        if (parsed && !figures.has(parsed.rwaId)) figures.set(parsed.rwaId, parsed)
      }
      const observed = cmcObservedAt(result.payload, 'rwaList')
      if (observed && (!listObservedAt || observed < listObservedAt)) listObservedAt = observed
    }
    // The list read is one provider observation per run, so its capture stamp is
    // this hour. Kept separately from the quotes stamp because the reconciliation
    // has to be able to say the two reads were not the same read.
    const listCapturedAt = figures.size ? capturedAt : null

    // ── 4. The zero-credit map, only for candidates the list pages did not
    //    carry. Without it a sticky asset outside the top 250 of its type would
    //    lose its name, symbol and type on every row.
    const unresolved = [...new Set([...sticky, ...seed.universeIds])].filter((id) => !figures.has(id))
    if (unresolved.length && calls + 2 <= budget) {
      const result = await deps.request('rwaMap', { limit: MAP_LIMIT, start: 1, sort: 'rwa_rank' }, ctx).catch(() => null)
      calls += 1
      // Documented as costing no credit, so nothing is added to `credits`.
      if (!result?.payload) partial = partial || 'map_unavailable'
      else {
        for (const row of cmcRows('rwaMap', result.payload).rows) {
          const parsed = assetListFigures(row)
          // The map carries identity only, never a market figure, so a mapped row
          // must not overwrite a list row that has one.
          if (parsed && unresolved.includes(parsed.rwaId) && !figures.has(parsed.rwaId)) figures.set(parsed.rwaId, parsed)
        }
      }
    }

    const candidates = rankCandidates(figures, { sticky, universeIds: seed.universeIds })
    if (!candidates.length) return { job, rows: 0, credits, capturedAt, calls, skipped: 'no_candidates', ...(partial ? { partial } : {}) }

    // ── 5. ONE quotes call for the whole set.
    if (calls + 1 > budget) return { job, rows: 0, credits, capturedAt, calls, skipped: 'call_budget', ...(partial ? { partial } : {}) }
    const quotes = await deps.request('rwaQuotes', { rwa_id: candidates.join(',') }, ctx).catch(() => null)
    calls += 1
    credits += 1
    if (!quotes?.payload) {
      return { job, rows: 0, credits, capturedAt, calls, candidates: candidates.length, error: text(quotes?.reason, 120) || 'provider_unavailable' }
    }

    // ── The NAV anchor, where one is mapped. The register is empty today, so
    //    this read is skipped entirely rather than run to find nothing.
    const navKeys = candidates.map((id) => RWA_NAV_ANCHORS[id]?.feedKey).filter((v): v is string => !!v)
    const navRead = navKeys.length
      ? await readRows(() => admin.from(NAV_TABLE).select('feed_key,captured_at,validation_state,nav,nav_observed_at,staleness')
          .in('feed_key', [...new Set(navKeys)]).order('captured_at', { ascending: false }).limit(navKeys.length * 4))
      : { rows: [], reason: null }
    const navByFeed = new Map<string, NavAnchorInput>()
    for (const row of navRead.rows) {
      const key = text(row?.feed_key, 60)
      if (!key || navByFeed.has(key)) continue
      navByFeed.set(key, {
        feedKey: key, nav: num(row?.nav), navObservedAt: text(row?.nav_observed_at, 40),
        validationState: text(row?.validation_state, 20), staleness: text(row?.staleness, 20),
        // The register admits only USD and EUR feeds and every mapped anchor is
        // a USD fund; the gate in `navAnchorUsable` refuses anything else.
        currency: 'USD',
      })
    }
    if (navRead.reason) partial = partial || 'nav_read_failed'

    const floor = Number.isFinite(Number(deps.liquidityFloorUsd)) && Number(deps.liquidityFloorUsd) >= 0
      ? Number(deps.liquidityFloorUsd) : LIQUIDITY_FLOOR_USD

    const assetRows: Record<string, unknown>[] = []
    const wrapperRows: Record<string, unknown>[] = []
    let multi = 0, anchored = 0, outsideBand = 0
    for (const row of cmcRows('rwaQuotes', quotes.payload).rows) {
      const asset = wrapperAssetFromQuote(row)
      if (!asset) continue
      const mapped = RWA_NAV_ANCHORS[asset.rwaId]
      const spread = wrapperSpread(asset, { nav: mapped ? navByFeed.get(mapped.feedKey) ?? null : null, liquidityFloorUsd: floor })
      // The whole surface is about assets wrapped MORE THAN ONCE. A single-token
      // asset is already answered by the RWA universe panel and would only pad
      // the table with rows whose dispersion is structurally absent.
      if (spread.wrapperCount < 2) continue
      multi += 1
      if (spread.anchorKind !== 'none') anchored += 1
      const list = figures.get(asset.rwaId) ?? null
      const built = assetRow(spread, list, { capturedAt, listCapturedAt, listObservedAt, fetchedAt, floor })
      if (built.reconcile_state === 'outside_band') outsideBand += 1
      assetRows.push(built)
      wrapperRows.push(...tokenRows(spread, { capturedAt, fetchedAt }))
    }

    if (!assetRows.length) {
      return {
        job, rows: 0, credits, capturedAt, calls, candidates: candidates.length,
        skipped: 'no_multi_wrapper_asset', ...(partial ? { partial } : {}),
      }
    }

    // The WRAPPERS go first. The cadence guard above reads the ASSET table, so
    // writing it last means a partial write can never make the next run believe
    // the hour was captured before the evidence behind it landed.
    const tokenWrite = await upsert(admin, TOKEN_TABLE, wrapperRows, 'provider,rwa_id,crypto_id,captured_at')
    const assetWrite = tokenWrite.error ? { rows: 0 } as { rows: number; error?: string } : await upsert(admin, ASSET_TABLE, assetRows, 'provider,rwa_id,captured_at')

    return {
      job, rows: tokenWrite.rows + assetWrite.rows, credits, capturedAt, calls,
      assetTypes: seed.assetTypes.length, candidates: candidates.length,
      assets: assetRows.length, wrappers: wrapperRows.length,
      multiWrapper: multi, anchored, outsideBand,
      ...(partial ? { partial } : {}),
      ...(tokenWrite.error || assetWrite.error ? { error: (tokenWrite.error || assetWrite.error) as string } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits, capturedAt, error: ((e as Error)?.message || 'rwa_wrapper_capture_failed').slice(0, 200) }
  }
}

/** Integration surface, wired in `intel-capture/index.ts` beside the other lanes.
 * The CoinMarketCap plan argument is accepted and ignored: every capability this
 * lane uses is available from Basic upward, so there is nothing to gate. */
export const RWA_WRAPPER_CAPTURE_OPS: Record<string, (
  // deno-lint-ignore no-explicit-any
  admin: any, ctxFor: (name: string, maxCalls: number) => MarketAssetsContext, now: Date, plan: string, deps: CaptureDeps, body?: Record<string, unknown>
) => Promise<JobResult>> = {
  rwa_wrappers: (admin, ctxFor, now, _plan, deps) => captureRwaWrappers(admin, ctxFor, now, deps as RwaWrapperDeps),
}
