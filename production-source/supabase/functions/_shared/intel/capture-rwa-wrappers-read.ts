// Investor Intel RWA wrapper spread read view.
//
// Same contract as the other lane read modules: pure functions over a
// PostgREST-shaped `db`, every read bounded by an explicit row cap, ordered
// newest first so hitting a cap loses the OLDEST rows, and `coverage` reporting
// the window actually read. An empty table is an empty list with `asOf: null`,
// never an error and never a fabricated row.
//
// The view answers with ONE row per captured asset for the newest capture hour,
// each carrying its wrappers. Rows from an older hour are never mixed in: two
// hours side by side would compare prices nobody measured together.
//
// A NEW view and a NEW op rather than a wider RWA universe read, so the universe
// panel and this one cannot blank each other and so neither lane's payload grows
// a second subject.
//
// The surface key is `capture_views`, which is free and precomputed: this is a
// shared read of rows one scheduled lane already paid for, so opening the page
// spends no provider credit whoever opens it.

import {
  RWA_WRAPPER_CAPTURE_SCHEDULE, ASSET_TABLE, TOKEN_TABLE,
} from './capture-rwa-wrappers.ts'
import {
  ANCHOR_MEANING, WRAPPER_SPREAD_SCOPE, LIQUIDITY_FLOOR_USD,
  RECONCILE_BAND_LOW, RECONCILE_BAND_HIGH, TROY_OUNCE_GRAMS,
  type AnchorKind,
} from './rwa-wrapper-spread.ts'

/** One capture hour holds at most RWA_WRAPPER_ASSET_CAP assets, so 200 asset
 * rows spans several hours and always contains the newest one whole. */
const ASSET_CAP = 200
/** 60 assets of up to a few dozen wrappers each, with headroom. */
const TOKEN_CAP = 1200
/** Assets returned to the surface in one read. */
const ROW_LIMIT = 60
/** Dots on the premium chart. Each is one wrapper of one asset. */
const POINT_CAP = 240

export interface Coverage { from: string | null; to: string | null; count: number; truncated?: boolean }
export interface ViewResult { view: string; asOf: string | null; coverage: Coverage; reason?: string | null; [key: string]: unknown }

export const RWA_WRAPPER_VIEWS = ['rwa_wrappers'] as const

const num = (v: unknown): number | null => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const str = (v: unknown, max = 400): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const at = (now: Date | number): number => (now instanceof Date ? now.getTime() : now)
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

const ASSET_COLUMNS = [
  'provider', 'rwa_id', 'captured_at', 'symbol', 'name', 'asset_type', 'rwa_rank',
  'anchor_kind', 'anchor_price', 'anchor_feed_key', 'anchor_observed_at', 'anchor_reason', 'anchor_members',
  'wrapper_count', 'liquid_count', 'thin_count', 'accrual_count',
  'unit_normalised_count', 'unit_refused_count', 'weight_denominated', 'volume_floor_usd',
  'widest_premium_bps', 'widest_premium_crypto_id', 'widest_discount_bps', 'widest_discount_crypto_id',
  'dispersion_bps', 'weighted_spread_bps', 'cheapest_crypto_id', 'cheapest_premium_bps',
  'average_tokenized_price', 'tokenized_market_cap', 'tokenized_volume_24h', 'source_observed_at',
  'list_tokenized_market_cap', 'list_tokenized_volume_24h', 'list_average_tokenized_price',
  'list_captured_at', 'list_observed_at', 'token_market_cap_sum', 'token_market_cap_reported',
  'reconcile_state', 'reconcile_ratio', 'reconcile_gap_usd', 'reconcile_reason',
  'reconcile_band_low', 'reconcile_band_high', 'fetched_at', 'scope',
].join(',')

const TOKEN_COLUMNS = [
  'rwa_id', 'crypto_id', 'captured_at', 'symbol', 'name', 'issuer_id', 'issuer_name',
  'price', 'normalised_price', 'market_cap', 'volume_24h',
  'unit_state', 'unit_factor', 'wrapper_state', 'premium_bps', 'accrual_gap_bps', 'in_anchor', 'state_reason',
].join(',')

/** One wrapper, as the surface reads it. */
// deno-lint-ignore no-explicit-any
export function wrapperRow(row: Record<string, any>) {
  return {
    cryptoId: str(row?.crypto_id, 20),
    symbol: str(row?.symbol, 50), name: str(row?.name, 200),
    issuerId: str(row?.issuer_id, 100), issuerName: str(row?.issuer_name, 200),
    price: num(row?.price), normalisedPrice: num(row?.normalised_price),
    marketCap: num(row?.market_cap), volume24h: num(row?.volume_24h),
    unitState: str(row?.unit_state, 40) || 'not_assessed', unitFactor: num(row?.unit_factor),
    state: str(row?.wrapper_state, 40) || 'no_price',
    // Two separate fields, because an accrual is not a premium and the surface
    // must not be able to read one as the other.
    premiumBps: num(row?.premium_bps), accrualGapBps: num(row?.accrual_gap_bps),
    inAnchor: bool(row?.in_anchor) ?? false,
    reason: str(row?.state_reason, 120),
  }
}

/** One underlying asset, as the surface reads it. */
// deno-lint-ignore no-explicit-any
export function wrapperAssetRow(row: Record<string, any>, tokens: ReturnType<typeof wrapperRow>[]) {
  const anchorKind = (str(row?.anchor_kind, 40) || 'none') as AnchorKind
  return {
    rwaId: str(row?.rwa_id, 20),
    symbol: str(row?.symbol, 50), name: str(row?.name, 200),
    assetType: str(row?.asset_type, 40), rwaRank: num(row?.rwa_rank),
    anchorKind,
    anchorPrice: num(row?.anchor_price),
    anchorFeedKey: str(row?.anchor_feed_key, 60),
    // The aggregator's or the provider's own clock for the anchor, never our
    // capture time.
    anchorObservedAt: str(row?.anchor_observed_at, 40),
    anchorReason: str(row?.anchor_reason, 120),
    anchorMembers: num(row?.anchor_members) ?? 0,
    anchorMeaning: ANCHOR_MEANING[anchorKind] ?? ANCHOR_MEANING.none,
    wrapperCount: num(row?.wrapper_count) ?? 0,
    liquidCount: num(row?.liquid_count) ?? 0,
    thinCount: num(row?.thin_count) ?? 0,
    accrualCount: num(row?.accrual_count) ?? 0,
    unitNormalisedCount: num(row?.unit_normalised_count) ?? 0,
    unitRefusedCount: num(row?.unit_refused_count) ?? 0,
    weightDenominated: bool(row?.weight_denominated) ?? false,
    volumeFloorUsd: num(row?.volume_floor_usd),
    widestPremiumBps: num(row?.widest_premium_bps), widestPremiumCryptoId: str(row?.widest_premium_crypto_id, 20),
    widestDiscountBps: num(row?.widest_discount_bps), widestDiscountCryptoId: str(row?.widest_discount_crypto_id, 20),
    dispersionBps: num(row?.dispersion_bps), weightedSpreadBps: num(row?.weighted_spread_bps),
    cheapestCryptoId: str(row?.cheapest_crypto_id, 20), cheapestPremiumBps: num(row?.cheapest_premium_bps),
    averageTokenizedPrice: num(row?.average_tokenized_price),
    tokenizedMarketCap: num(row?.tokenized_market_cap),
    tokenizedVolume24h: num(row?.tokenized_volume_24h),
    observedAt: str(row?.source_observed_at, 40),
    // The reconciliation, with BOTH numbers and BOTH clocks, because its whole
    // subject is that two reads of one provider disagree.
    listTokenizedMarketCap: num(row?.list_tokenized_market_cap),
    listTokenizedVolume24h: num(row?.list_tokenized_volume_24h),
    listAverageTokenizedPrice: num(row?.list_average_tokenized_price),
    listCapturedAt: str(row?.list_captured_at, 40), listObservedAt: str(row?.list_observed_at, 40),
    tokenMarketCapSum: num(row?.token_market_cap_sum),
    tokenMarketCapReported: num(row?.token_market_cap_reported) ?? 0,
    reconcileState: str(row?.reconcile_state, 40) || 'not_comparable',
    reconcileRatio: num(row?.reconcile_ratio),
    reconcileGapUsd: num(row?.reconcile_gap_usd),
    reconcileReason: str(row?.reconcile_reason, 120),
    scope: str(row?.scope, 800),
    fetchedAt: str(row?.fetched_at, 40),
    tokens,
  }
}

/** Assets ordered for a ranked table: widest absolute dispersion first, because
 * that is the question the surface asks. An asset with no dispersion (no anchor,
 * or fewer than two liquid wrappers) sorts after every asset that has one rather
 * than being dropped, and falls back to tokenised volume so the largest unanswered
 * assets are still visible. */
// deno-lint-ignore no-explicit-any
export function rankAssets(rows: any[]): any[] {
  return [...rows].sort((a, b) => {
    const da = a.dispersionBps == null ? -1 : Math.abs(a.dispersionBps)
    const db = b.dispersionBps == null ? -1 : Math.abs(b.dispersionBps)
    if (da !== db) return db - da
    const va = a.tokenizedVolume24h ?? -1
    const vb = b.tokenizedVolume24h ?? -1
    if (va !== vb) return vb - va
    return (a.rwaRank ?? Number.MAX_SAFE_INTEGER) - (b.rwaRank ?? Number.MAX_SAFE_INTEGER)
  })
}

/** Dots for the premium chart: one per wrapper that carries a premium, x = its
 * reported 24-hour volume, y = its premium in basis points. Wrappers with no
 * premium (unpriced, unit not established, accruing, no anchor) are not plotted
 * and are not counted as zero; they stay in the table with their state. */
// deno-lint-ignore no-explicit-any
export function premiumPoints(assets: any[], cap = POINT_CAP): any[] {
  const points: any[] = []
  for (const asset of assets) {
    for (const token of asset.tokens) {
      if (token.premiumBps == null || token.volume24h == null) continue
      points.push({
        key: `${asset.rwaId}:${token.cryptoId}`,
        assetRwaId: asset.rwaId, assetSymbol: asset.symbol, assetName: asset.name,
        cryptoId: token.cryptoId, symbol: token.symbol, name: token.name,
        x: token.volume24h, y: token.premiumBps,
        state: token.state, inAnchor: token.inAnchor,
      })
      if (points.length >= cap) return points
    }
  }
  return points
}

/** The newest captured hour, with one row per asset and its wrappers.
 *
 * `limit` bounds the assets returned; the reconciliation summary is computed over
 * the same set, so what the reader sees and what the summary counts agree. */
// deno-lint-ignore no-explicit-any
export async function readRwaWrappers(db: any, params: { limit?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const limit = Math.max(1, Math.min(ROW_LIMIT, Math.trunc(Number(params.limit) || ROW_LIMIT)))

  const assetRead = await readRows(() => db.from(ASSET_TABLE).select(ASSET_COLUMNS)
    .order('captured_at', { ascending: false }).limit(ASSET_CAP))
  const stamps = assetRead.rows.map((row) => str(row?.captured_at, 40)).filter((v): v is string => !!v).sort()
  const asOf = stamps.at(-1) ?? null

  const settings = {
    volumeFloorUsd: LIQUIDITY_FLOOR_USD,
    reconcileBandLow: RECONCILE_BAND_LOW,
    reconcileBandHigh: RECONCILE_BAND_HIGH,
    troyOunceGrams: TROY_OUNCE_GRAMS,
  }

  if (!asOf) {
    return {
      view: 'rwa_wrappers', rows: [], points: [], reconciliation: [],
      summary: { assets: 0, wrappers: 0, anchored: 0, navAnchored: 0, medianAnchored: 0, thin: 0, accruing: 0, unitNormalised: 0, unitRefused: 0, reconcileAgree: 0, reconcileOutside: 0, reconcileNotComparable: 0 },
      settings, scope: WRAPPER_SPREAD_SCOPE, anchorMeaning: ANCHOR_MEANING,
      // Nothing captured yet: when the lane runs, so the panel can say so rather
      // than drawing an empty table.
      schedule: RWA_WRAPPER_CAPTURE_SCHEDULE,
      asOf: null, coverage: emptyCoverage(), reason: assetRead.reason,
      generatedAt: new Date(at(now)).toISOString(),
    }
  }

  const current = assetRead.rows.filter((row) => str(row?.captured_at, 40) === asOf)
  const ids = [...new Set(current.map((row) => str(row?.rwa_id, 20)).filter((v): v is string => !!v))]
  const tokenRead = ids.length
    ? await readRows(() => db.from(TOKEN_TABLE).select(TOKEN_COLUMNS)
        .eq('captured_at', asOf).in('rwa_id', ids).limit(TOKEN_CAP))
    : { rows: [], reason: null }

  const tokensByAsset = new Map<string, ReturnType<typeof wrapperRow>[]>()
  for (const row of tokenRead.rows) {
    const id = str(row?.rwa_id, 20)
    if (!id) continue
    tokensByAsset.set(id, [...(tokensByAsset.get(id) || []), wrapperRow(row)])
  }
  // Dearest first inside an asset, with the wrappers that carry no premium last
  // and keeping their state rather than sorting to an implied zero.
  for (const [id, list] of tokensByAsset) {
    tokensByAsset.set(id, list.sort((a, b) => {
      if ((a.premiumBps == null) !== (b.premiumBps == null)) return a.premiumBps == null ? 1 : -1
      if (a.premiumBps != null && b.premiumBps != null) return b.premiumBps - a.premiumBps
      return (b.volume24h ?? -1) - (a.volume24h ?? -1)
    }))
  }

  const all = rankAssets(current.map((row) => wrapperAssetRow(row, tokensByAsset.get(str(row?.rwa_id, 20) ?? '') || [])))
  const rows = all.slice(0, limit)

  const reconciliation = rows
    .filter((row) => row.reconcileState !== 'not_comparable')
    .map((row) => ({
      rwaId: row.rwaId, symbol: row.symbol, name: row.name, assetType: row.assetType,
      state: row.reconcileState, ratio: row.reconcileRatio, reason: row.reconcileReason,
      listTokenizedMarketCap: row.listTokenizedMarketCap, listCapturedAt: row.listCapturedAt, listObservedAt: row.listObservedAt,
      tokenMarketCapSum: row.tokenMarketCapSum, tokenMarketCapReported: row.tokenMarketCapReported,
      quotesCapturedAt: asOf, quotesObservedAt: row.observedAt,
      gapUsd: row.reconcileGapUsd,
    }))
    // The largest disagreements first, in money rather than in ratio: a 40
    // percent gap on a $2,000 asset is not the finding a reader wants on top.
    .sort((a, b) => {
      const oa = a.state === 'outside_band' ? 1 : 0
      const ob = b.state === 'outside_band' ? 1 : 0
      if (oa !== ob) return ob - oa
      return Math.abs(b.gapUsd ?? 0) - Math.abs(a.gapUsd ?? 0)
    })

  return {
    view: 'rwa_wrappers',
    rows, points: premiumPoints(rows), reconciliation,
    summary: {
      assets: rows.length,
      wrappers: rows.reduce((sum, row) => sum + row.tokens.length, 0),
      anchored: rows.filter((row) => row.anchorKind !== 'none').length,
      navAnchored: rows.filter((row) => row.anchorKind === 'published_nav').length,
      medianAnchored: rows.filter((row) => row.anchorKind === 'liquid_wrapper_median').length,
      thin: rows.reduce((sum, row) => sum + row.thinCount, 0),
      accruing: rows.reduce((sum, row) => sum + row.accrualCount, 0),
      unitNormalised: rows.reduce((sum, row) => sum + row.unitNormalisedCount, 0),
      unitRefused: rows.reduce((sum, row) => sum + row.unitRefusedCount, 0),
      reconcileAgree: rows.filter((row) => row.reconcileState === 'agree').length,
      reconcileOutside: rows.filter((row) => row.reconcileState === 'outside_band').length,
      reconcileNotComparable: rows.filter((row) => row.reconcileState === 'not_comparable').length,
    },
    settings, scope: WRAPPER_SPREAD_SCOPE, anchorMeaning: ANCHOR_MEANING,
    schedule: RWA_WRAPPER_CAPTURE_SCHEDULE,
    // The two endpoints behind every figure on this surface, named on the payload
    // so the surface states them rather than restating them in JSX.
    endpoints: [
      { capability: 'rwaQuotes', path: '/v5/real-world-assets/quotes/latest', supplies: 'wrapper_prices' },
      { capability: 'rwaList', path: '/v5/real-world-assets/assets/list', supplies: 'asset_level_value' },
    ],
    asOf,
    coverage: { from: stamps[0] ?? null, to: asOf, count: rows.length, truncated: assetRead.rows.length >= ASSET_CAP || tokenRead.rows.length >= TOKEN_CAP || all.length > rows.length },
    reason: assetRead.reason || tokenRead.reason,
    generatedAt: new Date(at(now)).toISOString(),
  }
}

/** Integration surface consumed by `intel-capture/index.ts`, keyed by view name. */
export const RWA_WRAPPER_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_wrappers: (db, body, now) => readRwaWrappers(db, body, now),
}
