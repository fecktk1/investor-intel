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
//   6. For each tokenised STOCK or ETF, the listed share's own price from a
//      Chainlink on-chain feed (`underlying-reference.ts`), read at the instant
//      the wrapper prices were observed. Two zero-credit database reads for the
//      ticker-mapping evidence, then at most two public RPC requests per
//      registry ticker. Zero provider credits. Stored beside the anchor, never
//      in place of it.
//
//   7. Before any spread is computed, the dividend-reinvestment multiplier of
//      every wrapper that reinvests dividends into its price
//      (`accrual-multiplier.ts`): ONE batched keyless Solana RPC request for the
//      Ondo and xStocks mints, zero provider credits. A sourced multiplier gives a
//      per-share price; without one (or on a mixed-unit xStock) it is labelled.
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
  wrapperAssetFromQuote, assetListFigures, wrapperSpread, reconcileTokenValue, isDerivativeReference,
  RWA_NAV_ANCHORS, WRAPPER_SPREAD_SCOPE, LIQUIDITY_FLOOR_USD,
  RECONCILE_BAND_LOW, RECONCILE_BAND_HIGH,
  type AssetListFigures, type NavAnchorInput, type WrapperSpread, type WrapperAssetInput,
} from './rwa-wrapper-spread.ts'
import { PROFILE_TABLE, REGISTRANT_TABLE } from './capture-rwa-underlyings.ts'
import {
  chainlinkReferenceSource, resolveUnderlyingReferences, assetReferenceColumns, tokenReferenceColumns,
  observationRow, tradfiTickers, type UnderlyingReferenceSource, type ReferenceEvidence, type ReferenceOp,
} from './underlying-reference.ts'
import {
  resolveAccrual, solanaScaledUiMultiplierSource, type AccrualMultiplierSource, type AccrualStepResult,
} from './accrual-multiplier.ts'

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
/** The underlying stock reference, one row per asset per capture a feed read
 * was attempted for (migration 20260923193000). */
export const REFERENCE_TABLE = 'intel_rwa_underlying_reference_observations'

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
  /** Where the underlying stock's price comes from. Defaults to the committed
   * Chainlink registry read through public RPCs; a test injects a fake, and
   * `false` switches the step off without touching the wrapper capture. */
  referenceSource?: UnderlyingReferenceSource | false
  /** Where a reinvesting wrapper's dividend multiplier comes from. Defaults to
   * the Ondo and xStocks Solana mints over a public RPC; a test injects a fake, and `false`
   * switches the READ off: the wrappers are then still found and labelled as
   * not adjusted, never reported as premiums. */
  accrualSource?: AccrualMultiplierSource | false
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
    // Wrappers compared at a per-share price after a published dividend
    // multiplier (migration 20260923220000).
    accrual_adjusted_count: spread.accrualAdjustedCount,
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
 * wrong field, and the database enforces that only one of them is ever set.
 *
 * The `accrual_*` columns (migration 20260923220000) are set only on a wrapper
 * that reinvests dividends into its price: the multiplier it was divided by, its
 * source, its on-chain effective time and where it was read, or, when it was
 * not adjusted, why. Every key is always present so an upsert clears a stale one. */
export function tokenRows(spread: WrapperSpread, context: { capturedAt: string; fetchedAt: string }): Record<string, unknown>[] {
  return spread.tokens.map((row) => ({
    provider: CAPTURE_PROVIDER, rwa_id: spread.rwaId, crypto_id: row.cryptoId, captured_at: context.capturedAt,
    symbol: row.symbol, name: row.name, issuer_id: row.issuerId, issuer_name: row.issuerName,
    price: row.price, normalised_price: row.normalisedPrice,
    market_cap: row.marketCap, volume_24h: row.volume24h,
    unit_state: row.unitState, unit_factor: row.unitFactor,
    wrapper_state: row.state, premium_bps: row.premiumBps, accrual_gap_bps: row.accrualGapBps,
    in_anchor: row.inAnchor, state_reason: row.reason,
    accrual_treatment: row.accrualTreatment, accrual_reason: row.accrualReason,
    accrual_multiplier: row.accrualMultiplier, accrual_multiplier_source: row.accrualSource,
    accrual_multiplier_as_of: row.accrualAsOf, accrual_multiplier_network: row.accrualNetwork,
    accrual_multiplier_address: row.accrualAddress, accrual_multiplier_read_at: row.accrualReadAt,
    adjusted_price: row.adjustedPrice, raw_premium_bps: row.rawPremiumBps,
    fetched_at: context.fetchedAt,
  }))
}

// ─── The underlying stock reference ───────────────────────────────────────────

export interface ReferenceStepResult {
  /** Stock and ETF assets in the capture: the only ones a reference applies to. */
  stockAssets: number
  mapped: number
  observed: number
  withinBand: number
  unavailable: number
  noReference: number
  refused: number
  /** Distinct feed reads attempted (RPC, never a provider credit). */
  reads: number
  observations: Record<string, unknown>[]
  /** A failed evidence read narrows the mapping to symbol and type; said here. */
  partial: string | null
}

/** Add the underlying stock reference to rows the lane is about to write.
 *
 * Mutates `assetRows` and `wrapperRows` in place, adding the `underlying_ref_*`
 * columns, and returns the observation rows to store beside them. Nothing it
 * does can fail the wrapper capture: the only network it touches is the public
 * RPC, every read is bounded and timed, and a failed read is a row with a
 * reason. Two zero-credit database reads supply the mapping evidence (the
 * profile's primary exchange and the SEC registrant's tickers). */
export async function attachUnderlyingReferences(
  // deno-lint-ignore no-explicit-any
  admin: any,
  assetRows: Record<string, unknown>[],
  wrapperRows: Record<string, unknown>[],
  context: { tradfi: Map<string, string[] | null>; capturedAt: string; fetchedAt: string; op: ReferenceOp },
  source: UnderlyingReferenceSource,
): Promise<ReferenceStepResult> {
  const stock = assetRows.filter((row) => row.asset_type === 'stock' || row.asset_type === 'etf')
  const ids = [...new Set(stock.map((row) => rwaId(row.rwa_id)).filter((v): v is string => !!v))]
  const [profiles, registrants] = ids.length
    ? await Promise.all([
        readRows(() => admin.from(PROFILE_TABLE).select('rwa_id,primary_exchange').in('rwa_id', ids).limit(ids.length)),
        readRows(() => admin.from(REGISTRANT_TABLE).select('rwa_id,tickers').in('rwa_id', ids).limit(ids.length)),
      ])
    : [{ rows: [], reason: null }, { rows: [], reason: null }]
  const evidence = new Map<string, ReferenceEvidence>()
  for (const id of ids) evidence.set(id, { tradfiTickers: context.tradfi.get(id) ?? null })
  for (const row of profiles.rows) {
    const id = rwaId(row?.rwa_id)
    if (id && evidence.has(id)) evidence.get(id)!.primaryExchange = text(row?.primary_exchange, 120)
  }
  for (const row of registrants.rows) {
    const id = rwaId(row?.rwa_id)
    if (id && evidence.has(id)) evidence.get(id)!.registrantTickers = Array.isArray(row?.tickers) ? row.tickers : null
  }

  const { outcomes, reads } = await resolveUnderlyingReferences(
    stock.map((row) => ({
      rwaId: String(row.rwa_id), symbol: text(row.symbol, 50), assetType: text(row.asset_type, 40),
      // The provider's clock for the wrapper prices, so the stock is read at the
      // same instant the wrappers were priced.
      observedAt: text(row.source_observed_at, 40),
    })),
    evidence, source,
  )

  // Columns are computed first and applied last, so nothing is half-written.
  const assetColumns = assetRows.map((row) => assetReferenceColumns(outcomes.get(String(row.rwa_id)) ?? null, num(row.anchor_price), context.fetchedAt))
  const tokenColumns = wrapperRows.map((row) => tokenReferenceColumns(row, outcomes.get(String(row.rwa_id)) ?? null))
  assetRows.forEach((row, i) => Object.assign(row, assetColumns[i]))
  wrapperRows.forEach((row, i) => Object.assign(row, tokenColumns[i]))

  const observations: Record<string, unknown>[] = []
  let mapped = 0, observed = 0, unavailable = 0, noReference = 0, refused = 0
  for (const id of ids) {
    const outcome = outcomes.get(id) ?? null
    const state = outcome?.mapping.state
    if (state === 'mapped') {
      mapped += 1
      if (outcome?.reading?.state === 'observed') observed += 1
      else unavailable += 1
    } else if (state === 'mapping_refused') refused += 1
    else if (state === 'no_reference') noReference += 1
    const observation = observationRow(id, outcome, context)
    if (observation) observations.push(observation)
  }
  return {
    stockAssets: ids.length, mapped, observed, unavailable, noReference, refused, reads, observations,
    withinBand: assetRows.filter((row) => row.underlying_ref_anchor_within_band === true).length,
    partial: profiles.reason ? 'profile_read_failed' : registrants.reason ? 'registrant_read_failed' : null,
  }
}

const NO_REFERENCE: ReferenceStepResult = {
  stockAssets: 0, mapped: 0, observed: 0, withinBand: 0, unavailable: 0, noReference: 0, refused: 0, reads: 0, observations: [], partial: null,
}

/** The reference step as the lane runs it: switched off by `referenceSource:
 * false`, and a throw from anywhere inside it is caught and reported, leaving
 * the wrapper rows exactly as the spread built them. */
async function referenceStep(
  // deno-lint-ignore no-explicit-any
  admin: any,
  assetRows: Record<string, unknown>[],
  wrapperRows: Record<string, unknown>[],
  context: { tradfi: Map<string, string[] | null>; capturedAt: string; fetchedAt: string; op: ReferenceOp },
  deps: RwaWrapperDeps,
): Promise<ReferenceStepResult & { error?: string }> {
  if (deps.referenceSource === false) return { ...NO_REFERENCE, partial: 'reference_switched_off' }
  try {
    return await attachUnderlyingReferences(admin, assetRows, wrapperRows, context, deps.referenceSource || chainlinkReferenceSource())
  } catch (e) {
    return { ...NO_REFERENCE, error: ((e as Error)?.message || 'reference_failed').slice(0, 120) }
  }
}

// ─── The dividend-reinvestment multiplier ─────────────────────────────────────

/** Multiplier verdicts for the assets a run is about to compute. Only an asset
 * that can reach the board (two or more non-derivative tokens) is read for, so a
 * single-wrapper asset never costs an RPC slot. Never throws and never leaves a
 * reinvesting wrapper unclassified: if the resolution itself fails, every such
 * wrapper is still labelled not adjusted with the reason. */
export async function accrualStep(
  assets: WrapperAssetInput[],
  readAt: string,
  deps: Pick<RwaWrapperDeps, 'accrualSource'>,
): Promise<AccrualStepResult> {
  const inputs = assets
    .filter((asset) => asset.tokens.filter((token) => !isDerivativeReference(token)).length >= 2)
    .map((asset) => ({ rwaId: asset.rwaId, observedAt: asset.observedAt, tokens: asset.tokens }))
  const source = deps.accrualSource === false ? false : deps.accrualSource || solanaScaledUiMultiplierSource()
  try {
    return await resolveAccrual(inputs, source, readAt)
  } catch (e) {
    const message = ((e as Error)?.message || 'multiplier_read_failed').slice(0, 120)
    try {
      const failing: AccrualMultiplierSource = { id: 'solana_scaled_ui', network: 'solana', read: () => Promise.reject(new Error(message)) }
      return await resolveAccrual(inputs, failing, readAt)
    } catch {
      return { verdicts: new Map(), reinvesting: 0, adjusted: 0, notAdjusted: 0, reads: 0, error: message }
    }
  }
}

function accrualSummary(step: AccrualStepResult) {
  return {
    reinvesting: step.reinvesting, adjusted: step.adjusted, notAdjusted: step.notAdjusted, reads: step.reads,
    ...(step.error ? { error: step.error } : {}),
  }
}

function referenceSummary(step: ReferenceStepResult & { error?: string }, write: { rows: number; error?: string }) {
  return {
    stockAssets: step.stockAssets, mapped: step.mapped, observed: step.observed, withinBand: step.withinBand,
    unavailable: step.unavailable, noReference: step.noReference, refused: step.refused, reads: step.reads,
    stored: write.rows,
    ...(step.partial ? { partial: step.partial } : {}),
    ...(step.error || write.error ? { error: (step.error || write.error) as string } : {}),
  }
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
    // The quotes payload's own `tradfi_markets` tickers: a free cross-check for
    // the stock reference's ticker mapping (no extra call).
    const tradfi = new Map<string, string[] | null>()
    const parsed: WrapperAssetInput[] = []
    for (const row of cmcRows('rwaQuotes', quotes.payload).rows) {
      const asset = wrapperAssetFromQuote(row)
      if (!asset) continue
      tradfi.set(asset.rwaId, tradfiTickers(row))
      parsed.push(asset)
    }
    // ── The dividend multipliers, BEFORE any spread: an adjusted wrapper may
    //    anchor at its per-share price, so the anchor depends on them. RPC only,
    //    zero credits, and unable to fail the capture.
    const accrual = await accrualStep(parsed, fetchedAt, deps)
    let multi = 0, anchored = 0, outsideBand = 0
    for (const asset of parsed) {
      const mapped = RWA_NAV_ANCHORS[asset.rwaId]
      const spread = wrapperSpread(asset, {
        nav: mapped ? navByFeed.get(mapped.feedKey) ?? null : null, liquidityFloorUsd: floor,
        accrual: accrual.verdicts.get(asset.rwaId) ?? null,
      })
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

    // ── The underlying stock's own price, BESIDE the anchor. RPC reads only,
    //    zero credits, and unable to fail the capture it sits in.
    const reference = await referenceStep(admin, assetRows, wrapperRows, { tradfi, capturedAt, fetchedAt, op: 'rwa_wrappers' }, deps)

    // The WRAPPERS go first. The cadence guard above reads the ASSET table, so
    // writing it last means a partial write can never make the next run believe
    // the hour was captured before the evidence behind it landed.
    const tokenWrite = await upsert(admin, TOKEN_TABLE, wrapperRows, 'provider,rwa_id,crypto_id,captured_at')
    const referenceWrite = tokenWrite.error || !reference.observations.length
      ? { rows: 0 } as { rows: number; error?: string }
      : await upsert(admin, REFERENCE_TABLE, reference.observations, 'rwa_id,captured_at,source')
    const assetWrite = tokenWrite.error ? { rows: 0 } as { rows: number; error?: string } : await upsert(admin, ASSET_TABLE, assetRows, 'provider,rwa_id,captured_at')

    return {
      job, rows: tokenWrite.rows + assetWrite.rows, credits, capturedAt, calls,
      assetTypes: seed.assetTypes.length, candidates: candidates.length,
      assets: assetRows.length, wrappers: wrapperRows.length,
      multiWrapper: multi, anchored, outsideBand,
      accrual: accrualSummary(accrual),
      reference: referenceSummary(reference, referenceWrite),
      ...(partial ? { partial } : {}),
      ...(tokenWrite.error || assetWrite.error ? { error: (tokenWrite.error || assetWrite.error) as string } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits, capturedAt, error: ((e as Error)?.message || 'rwa_wrapper_capture_failed').slice(0, 200) }
  }
}

/** How old the newest wrapper capture may be for the one-off reference step.
 * The round walk behind a reading is bounded, and the step exists only to fill
 * the NEWEST capture before the next scheduled run writes its own. */
export const REFERENCE_BACKFILL_MAX_AGE_MS = 13 * 3_600_000

/** Run ONLY the underlying reference step over the newest wrapper capture, and
 * write its columns and observations back onto the rows already stored.
 *
 * Zero CoinMarketCap calls: two reads of this lane's own rows, the two evidence
 * reads, and the bounded feed reads. The stock is read at each asset's stored
 * `source_observed_at`, so a reference filled in hours after the capture is
 * still the price in effect when the wrappers were priced. Idempotent: a second
 * run rewrites the same rows. Not scheduled; an operator runs it by hand. */
export async function captureUnderlyingReferenceForLatest(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: Date,
  deps: RwaWrapperDeps,
): Promise<JobResult> {
  const job = 'rwa_wrapper_reference'
  const fetchedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
  try {
    if (!lanePolicy(deps).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    if (deps.referenceSource === false) return { job, rows: 0, credits: 0, skipped: 'reference_switched_off' }
    const newest = await readRows(() => admin.from(ASSET_TABLE).select('captured_at').order('captured_at', { ascending: false }).limit(1))
    if (newest.reason) return { job, rows: 0, credits: 0, error: newest.reason }
    const capturedAt = text(newest.rows[0]?.captured_at, 40)
    if (!capturedAt) return { job, rows: 0, credits: 0, skipped: 'no_wrapper_capture' }
    const capturedMs = Date.parse(capturedAt)
    if (!Number.isFinite(capturedMs) || now.getTime() - capturedMs > REFERENCE_BACKFILL_MAX_AGE_MS) {
      return { job, rows: 0, credits: 0, skipped: 'newest_capture_too_old', capturedAt }
    }
    const [assets, tokens] = await Promise.all([
      readRows(() => admin.from(ASSET_TABLE).select('*').eq('captured_at', capturedAt).limit(RWA_WRAPPER_ASSET_CAP * 2)),
      readRows(() => admin.from(TOKEN_TABLE).select('*').eq('captured_at', capturedAt).limit(MAX_UPSERT_ROWS * 4)),
    ])
    if (assets.reason || tokens.reason) return { job, rows: 0, credits: 0, capturedAt, error: (assets.reason || tokens.reason) as string }
    // `created_at` stays with the row that already holds it.
    const strip = (row: Record<string, unknown>) => { const { created_at: _created, ...rest } = row; return rest }
    const assetRows: Record<string, unknown>[] = assets.rows.map(strip)
    const wrapperRows: Record<string, unknown>[] = tokens.rows.map(strip)
    const reference = await referenceStep(admin, assetRows, wrapperRows, { tradfi: new Map(), capturedAt, fetchedAt, op: 'rwa_wrapper_reference' }, deps)
    if (reference.error) return { job, rows: 0, credits: 0, capturedAt, error: reference.error }
    const tokenWrite = await upsert(admin, TOKEN_TABLE, wrapperRows, 'provider,rwa_id,crypto_id,captured_at')
    const referenceWrite = tokenWrite.error || !reference.observations.length
      ? { rows: 0 } as { rows: number; error?: string }
      : await upsert(admin, REFERENCE_TABLE, reference.observations, 'rwa_id,captured_at,source')
    const assetWrite = tokenWrite.error ? { rows: 0 } as { rows: number; error?: string } : await upsert(admin, ASSET_TABLE, assetRows, 'provider,rwa_id,captured_at')
    return {
      job, rows: tokenWrite.rows + referenceWrite.rows + assetWrite.rows, credits: 0, capturedAt,
      reference: referenceSummary(reference, referenceWrite),
      ...(tokenWrite.error || assetWrite.error ? { error: (tokenWrite.error || assetWrite.error) as string } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_wrapper_reference_failed').slice(0, 200) }
  }
}

/** The provider's asset as the lane parsed it, rebuilt from a STORED capture:
 * every input `wrapperSpread` reads is a stored column, so recomputing a stored
 * capture with new multipliers uses exactly the prices, volumes and issuers that
 * capture read. Exported for tests. */
export function assetFromStoredRows(
  assetRow: Record<string, unknown>,
  tokens: Record<string, unknown>[],
): WrapperAssetInput | null {
  const id = rwaId(assetRow.rwa_id)
  if (!id) return null
  const positive = (v: unknown) => { const n = num(v); return n != null && n > 0 ? n : null }
  const size = (v: unknown) => { const n = num(v); return n != null && n >= 0 ? n : null }
  return {
    rwaId: id,
    symbol: text(assetRow.symbol, 50), name: text(assetRow.name, 200), assetType: text(assetRow.asset_type, 40),
    rwaRank: (() => { const n = num(assetRow.rwa_rank); return n != null && n > 0 ? Math.trunc(n) : null })(),
    averageTokenizedPrice: positive(assetRow.average_tokenized_price),
    tokenizedMarketCap: size(assetRow.tokenized_market_cap),
    tokenizedVolume24h: size(assetRow.tokenized_volume_24h),
    observedAt: text(assetRow.source_observed_at, 40),
    tokens: tokens
      .filter((row) => rwaId(row.crypto_id))
      .map((row) => ({
        cryptoId: rwaId(row.crypto_id), symbol: text(row.symbol, 50), name: text(row.name, 200),
        issuerId: text(row.issuer_id, 100), issuerName: text(row.issuer_name, 200),
        price: positive(row.price), marketCap: size(row.market_cap), volume24h: size(row.volume_24h),
      })),
  }
}

/** Recompute the NEWEST wrapper capture with the dividend-reinvestment
 * multipliers, then re-run the stock reference over it, and write both back onto
 * the rows already stored. So the board shows the adjustment before the next
 * scheduled run instead of six hours later.
 *
 * Zero CoinMarketCap calls: two reads of this lane's own rows, one batched Solana
 * RPC request for the multipliers, and the reference step's evidence reads and
 * feed reads. Every multiplier is taken as in effect at each asset's stored
 * `source_observed_at`, exactly as the scheduled lane takes it. An asset anchored
 * to a published NAV is left as stored (none is mapped today). Idempotent. Not
 * scheduled; an operator runs it by hand. If the reference step cannot run, NOTHING
 * is written: a recomputed premium beside a stale gap to the stock would disagree. */
export async function captureAccrualForLatest(
  // deno-lint-ignore no-explicit-any
  admin: any,
  now: Date,
  deps: RwaWrapperDeps,
): Promise<JobResult> {
  const job = 'rwa_wrapper_accrual'
  const fetchedAt = new Date(now instanceof Date ? now.getTime() : now).toISOString()
  try {
    if (!lanePolicy(deps).enabled) return { job, rows: 0, credits: 0, skipped: 'policy_disabled' }
    if (deps.referenceSource === false) return { job, rows: 0, credits: 0, skipped: 'reference_switched_off' }
    const newest = await readRows(() => admin.from(ASSET_TABLE).select('captured_at').order('captured_at', { ascending: false }).limit(1))
    if (newest.reason) return { job, rows: 0, credits: 0, error: newest.reason }
    const capturedAt = text(newest.rows[0]?.captured_at, 40)
    if (!capturedAt) return { job, rows: 0, credits: 0, skipped: 'no_wrapper_capture' }
    const capturedMs = Date.parse(capturedAt)
    if (!Number.isFinite(capturedMs) || now.getTime() - capturedMs > REFERENCE_BACKFILL_MAX_AGE_MS) {
      return { job, rows: 0, credits: 0, skipped: 'newest_capture_too_old', capturedAt }
    }
    const [assets, tokens] = await Promise.all([
      readRows(() => admin.from(ASSET_TABLE).select('*').eq('captured_at', capturedAt).limit(RWA_WRAPPER_ASSET_CAP * 2)),
      readRows(() => admin.from(TOKEN_TABLE).select('*').eq('captured_at', capturedAt).limit(MAX_UPSERT_ROWS * 4)),
    ])
    if (assets.reason || tokens.reason) return { job, rows: 0, credits: 0, capturedAt, error: (assets.reason || tokens.reason) as string }
    const strip = (row: Record<string, unknown>) => { const { created_at: _created, ...rest } = row; return rest }
    const tokensByAsset = new Map<string, Record<string, unknown>[]>()
    for (const row of tokens.rows.map(strip)) {
      const id = rwaId(row.rwa_id)
      if (id) tokensByAsset.set(id, [...(tokensByAsset.get(id) || []), row])
    }
    const stored = assets.rows.map(strip)
    const rebuilt = stored
      .map((row) => ({ row, asset: RWA_NAV_ANCHORS[String(row.rwa_id)] ? null : assetFromStoredRows(row, tokensByAsset.get(String(row.rwa_id)) || []) }))
    const accrual = await accrualStep(rebuilt.map((r) => r.asset).filter((a): a is WrapperAssetInput => !!a), fetchedAt, deps)

    const assetRows: Record<string, unknown>[] = []
    const wrapperRows: Record<string, unknown>[] = []
    for (const { row, asset } of rebuilt) {
      const id = String(row.rwa_id)
      const storedTokens = tokensByAsset.get(id) || []
      if (!asset) { assetRows.push(row); wrapperRows.push(...storedTokens); continue }
      const floor = num(row.volume_floor_usd) ?? LIQUIDITY_FLOOR_USD
      const spread = wrapperSpread(asset, { liquidityFloorUsd: floor, accrual: accrual.verdicts.get(id) ?? null })
      const list: AssetListFigures = {
        rwaId: id, symbol: asset.symbol, name: asset.name, assetType: asset.assetType, rwaRank: asset.rwaRank, hasTokens: null,
        averageTokenizedPrice: num(row.list_average_tokenized_price),
        tokenizedMarketCap: num(row.list_tokenized_market_cap),
        tokenizedVolume24h: num(row.list_tokenized_volume_24h),
        observedAt: text(row.list_observed_at, 40),
      }
      // The capture's own clocks stay: this is a recompute, not a new read.
      const storedFetchedAt = text(row.fetched_at, 40) || fetchedAt
      assetRows.push({
        ...row,
        ...assetRow(spread, list, { capturedAt, listCapturedAt: text(row.list_captured_at, 40), listObservedAt: text(row.list_observed_at, 40), fetchedAt: storedFetchedAt, floor }),
      })
      const byCrypto = new Map(storedTokens.map((t) => [String(t.crypto_id), t]))
      for (const built of tokenRows(spread, { capturedAt, fetchedAt: text(storedTokens[0]?.fetched_at, 40) || storedFetchedAt })) {
        wrapperRows.push({ ...(byCrypto.get(String(built.crypto_id)) || {}), ...built })
      }
    }

    const reference = await referenceStep(admin, assetRows, wrapperRows, { tradfi: new Map(), capturedAt, fetchedAt, op: 'rwa_wrapper_accrual' }, deps)
    if (reference.error) return { job, rows: 0, credits: 0, capturedAt, accrual: accrualSummary(accrual), error: reference.error }
    const tokenWrite = await upsert(admin, TOKEN_TABLE, wrapperRows, 'provider,rwa_id,crypto_id,captured_at')
    const referenceWrite = tokenWrite.error || !reference.observations.length
      ? { rows: 0 } as { rows: number; error?: string }
      : await upsert(admin, REFERENCE_TABLE, reference.observations, 'rwa_id,captured_at,source')
    const assetWrite = tokenWrite.error ? { rows: 0 } as { rows: number; error?: string } : await upsert(admin, ASSET_TABLE, assetRows, 'provider,rwa_id,captured_at')
    return {
      job, rows: tokenWrite.rows + referenceWrite.rows + assetWrite.rows, credits: 0, capturedAt,
      assets: assetRows.length, wrappers: wrapperRows.length,
      accrual: accrualSummary(accrual),
      reference: referenceSummary(reference, referenceWrite),
      ...(tokenWrite.error || assetWrite.error ? { error: (tokenWrite.error || assetWrite.error) as string } : {}),
    }
  } catch (e) {
    return { job, rows: 0, credits: 0, error: ((e as Error)?.message || 'rwa_wrapper_accrual_failed').slice(0, 200) }
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
  // Not scheduled: an operator's one-off fill of the newest capture's stock
  // reference. Zero credits (captureUnderlyingReferenceForLatest).
  rwa_wrapper_reference: (admin, _ctxFor, now, _plan, deps) => captureUnderlyingReferenceForLatest(admin, now, deps as RwaWrapperDeps),
  // Not scheduled: an operator's one-off recompute of the newest capture with
  // the dividend-reinvestment multipliers, then its stock reference. Zero
  // credits (captureAccrualForLatest).
  rwa_wrapper_accrual: (admin, _ctxFor, now, _plan, deps) => captureAccrualForLatest(admin, now, deps as RwaWrapperDeps),
}
