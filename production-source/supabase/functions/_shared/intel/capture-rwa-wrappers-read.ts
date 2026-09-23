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
import { PROFILE_TABLE } from './capture-rwa-underlyings.ts'
import {
  ANCHOR_MEANING, WRAPPER_SPREAD_SCOPE, LIQUIDITY_FLOOR_USD,
  RECONCILE_BAND_LOW, RECONCILE_BAND_HIGH, TROY_OUNCE_GRAMS,
  type AnchorKind,
} from './rwa-wrapper-spread.ts'
import { wrapperPicks, PICK_RULES } from './rwa-wrapper-picks.ts'
import { REFERENCE_CHAINS, REFERENCE_SCOPE } from './underlying-reference.ts'

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

export const RWA_WRAPPER_VIEWS = ['rwa_wrappers', 'rwa_wrapper_picks'] as const

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
  // The underlying stock reference (migration 20260923193000), all nullable.
  'underlying_ref_state', 'underlying_ref_reason', 'underlying_ref_ticker', 'underlying_ref_source',
  'underlying_ref_price', 'underlying_ref_feed', 'underlying_ref_network', 'underlying_ref_address',
  'underlying_ref_deviation_pct', 'underlying_ref_heartbeat_s', 'underlying_ref_hours',
  'underlying_ref_observed_at', 'underlying_ref_compared_at', 'underlying_ref_age_s', 'underlying_ref_session',
  'underlying_ref_anchor_bps', 'underlying_ref_anchor_within_band', 'underlying_ref_fetched_at',
].join(',')

const TOKEN_COLUMNS = [
  'rwa_id', 'crypto_id', 'captured_at', 'symbol', 'name', 'issuer_id', 'issuer_name',
  'price', 'normalised_price', 'market_cap', 'volume_24h',
  'unit_state', 'unit_factor', 'wrapper_state', 'premium_bps', 'accrual_gap_bps', 'in_anchor', 'state_reason',
  'underlying_ref_price', 'underlying_ref_bps', 'underlying_ref_within_band', 'underlying_ref_session',
  'underlying_ref_observed_at', 'underlying_ref_source',
].join(',')

/** The catalogue table the wrapper TOKEN logos come from, and the profile table
 * the UNDERLYING asset logos come from. Both are joined server side, in this
 * read, so the surface makes one request and never one request per row. */
export const CATALOGUE_TABLE = 'market_assets'
/** Catalogue rows one logo read may return. One asset can carry a few dozen
 * wrappers, so this sits above TOKEN_CAP's realistic distinct-id count. */
const LOGO_CAP = 1200

/** An image the surface may render. Only https: a provider row that ever carries
 * an http or a data URL is dropped rather than put in an <img>. */
const image = (v: unknown): string | null => {
  const s = str(v, 500)
  return s && /^https:\/\//i.test(s) ? s : null
}

interface Logo { cached: string | null; original: string | null }

/** What the catalogue says about one wrapper's markets: how many market pairs
 * CoinMarketCap counts for it, and whether it is in the catalogue's current
 * refresh at all. Read in the same bounded query as the logos. */
export interface CatalogueMarket { marketPairs: number | null; inCurrentCatalog: boolean | null }

export const MARKET_COVERAGE_STATES = ['tradeable', 'priced_not_traded', 'listed_only', 'no_tracked_market'] as const
export type MarketCoverage = typeof MARKET_COVERAGE_STATES[number]

/** Whether a wrapper can be traded anywhere we can see, in four words.
 *
 *   listed_only        the provider lists the wrapper with no price at all.
 *   priced_not_traded  a price, but no reported 24 hour volume (absent or zero),
 *                      or the catalogue counts zero market pairs for it.
 *   no_tracked_market  a price and a volume, but the wrapper is not in the
 *                      market catalogue's current refresh, so there is no pair
 *                      count of ours to confirm a market. The provider's volume
 *                      is still shown beside it; this is a statement about OUR
 *                      coverage, not a claim that it does not trade.
 *   tradeable          a price, a volume, and a current catalogue row. A pair
 *                      count the catalogue did not report is said as a reason,
 *                      never read as zero.
 *
 * A catalogue read that FAILED assesses nothing: `state` is null and the reason
 * says why, rather than every wrapper quietly becoming "no tracked market". */
export function marketCoverage(
  token: { price: number | null; volume24h: number | null },
  market: CatalogueMarket | null,
  catalogueRead: boolean,
): { state: MarketCoverage | null; reason: string | null } {
  if (token.price == null) return { state: 'listed_only', reason: 'price_not_reported' }
  if (token.volume24h == null) return { state: 'priced_not_traded', reason: 'volume_not_reported' }
  if (token.volume24h <= 0) return { state: 'priced_not_traded', reason: 'volume_reported_zero' }
  if (!catalogueRead) return { state: null, reason: 'catalogue_unavailable' }
  if (!market || market.inCurrentCatalog === false) return { state: 'no_tracked_market', reason: market ? 'not_in_current_catalogue' : 'not_in_catalogue' }
  if (market.marketPairs === 0) return { state: 'priced_not_traded', reason: 'no_market_pairs' }
  return { state: 'tradeable', reason: market.marketPairs == null ? 'pair_count_not_reported' : null }
}

/** CoinMarketCap's own coin image for a numeric crypto id, or null. The same URL
 * shape `assetLogoUrl` builds in the app (src/intel/lib/asset-identity.js). */
export function cmcCoinLogo(id: unknown): string | null {
  const v = String(id ?? '').trim()
  return /^[1-9][0-9]{0,11}$/.test(v) ? `https://s2.coinmarketcap.com/static/img/coins/64x64/${v}.png` : null
}

/** The picture an underlying asset shows when CoinMarketCap publishes none for it
 * (it publishes none for the largest names: Nvidia, Apple, Microsoft). A tokenised
 * STOCK or ETF borrows the image of its largest wrapper by market cap, which is
 * the issuer's rendering of the same company mark. A commodity never does: the
 * logo of one gold token is a brand, not a picture of gold, so it keeps the
 * monogram. */
// deno-lint-ignore no-explicit-any
export function underlyingFallbackLogo(assetType: unknown, tokens: { logoUrl: string | null; marketCap: number | null }[]): string | null {
  const type = String(assetType ?? '')
  if (type !== 'stock' && type !== 'etf') return null
  const ranked = tokens.filter((t) => t.logoUrl).sort((x, y) => (y.marketCap ?? -1) - (x.marketCap ?? -1))
  return ranked[0]?.logoUrl ?? null
}

/** One wrapper, as the surface reads it.
 *
 * `logo` is the catalogue's image for this token, already looked up by the
 * caller. The mirrored copy leads and the provider's own URL is the fallback,
 * which is the candidate order TokenAvatar walks before it falls back to a
 * monogram. A wrapper with no catalogue row keeps the monogram and nothing
 * about it changes. */
// deno-lint-ignore no-explicit-any
export function wrapperRow(row: Record<string, any>, logo: Logo | null = null) {
  // A wrapper the catalogue has never met still has a CoinMarketCap id, and the
  // provider's coin image is addressed by that id alone. It is built from the id,
  // never from a ticker, and TokenAvatar drops to the monogram if it 404s.
  const byId = cmcCoinLogo(row?.crypto_id)
  return {
    logoUrl: logo?.cached ?? logo?.original ?? byId,
    fallbackLogoUrl: logo?.original ?? byId,
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
    // This wrapper against the listed share (underlying-reference.ts). Null on
    // every row the reference does not apply to or could not be read for.
    // `underlyingRefWithinBand` true means the gap is inside the feed's own
    // update band and is NOT distinguishable from zero.
    underlyingRefPrice: num(row?.underlying_ref_price),
    underlyingRefBps: num(row?.underlying_ref_bps),
    underlyingRefWithinBand: bool(row?.underlying_ref_within_band),
    underlyingRefSession: str(row?.underlying_ref_session, 20),
    underlyingRefObservedAt: str(row?.underlying_ref_observed_at, 40),
    underlyingRefSource: str(row?.underlying_ref_source, 20),
  }
}

/** The listed share's own price for one asset row, or null where no reference
 * applies (a commodity, or a row captured before the reference existed). Every
 * state but `observed` carries its reason, and nothing here is a zero. */
// deno-lint-ignore no-explicit-any
export function underlyingReferenceRow(row: Record<string, any>) {
  const state = str(row?.underlying_ref_state, 40)
  if (!state) return null
  const network = str(row?.underlying_ref_network, 20)
  return {
    state,
    reason: str(row?.underlying_ref_reason, 120),
    ticker: str(row?.underlying_ref_ticker, 12),
    source: str(row?.underlying_ref_source, 20),
    price: num(row?.underlying_ref_price),
    feed: str(row?.underlying_ref_feed, 120),
    network,
    networkLabel: network && Object.hasOwn(REFERENCE_CHAINS, network) ? REFERENCE_CHAINS[network as keyof typeof REFERENCE_CHAINS].label : network,
    address: str(row?.underlying_ref_address, 42),
    deviationPct: num(row?.underlying_ref_deviation_pct),
    heartbeatSeconds: num(row?.underlying_ref_heartbeat_s),
    hours: str(row?.underlying_ref_hours, 20),
    // The round's own update time, the instant it is compared at (when the
    // wrapper prices were observed), and the age between the two.
    observedAt: str(row?.underlying_ref_observed_at, 40),
    comparedAt: str(row?.underlying_ref_compared_at, 40),
    ageSeconds: num(row?.underlying_ref_age_s),
    session: str(row?.underlying_ref_session, 20),
    anchorBps: num(row?.underlying_ref_anchor_bps),
    anchorWithinBand: bool(row?.underlying_ref_anchor_within_band),
    fetchedAt: str(row?.underlying_ref_fetched_at, 40),
  }
}

/** One underlying asset, as the surface reads it.
 *
 * `logoUrl` is CoinMarketCap's own image for the UNDERLYING asset (Nvidia, gold,
 * an ETF), taken from the stored profile rather than fetched: the profile lane
 * already wrote it and this read spends nothing to use it. Null until that lane
 * has reached the asset, and a null is a monogram, never a broken image. */
// deno-lint-ignore no-explicit-any
export function wrapperAssetRow(row: Record<string, any>, tokens: ReturnType<typeof wrapperRow>[], logoUrl: string | null = null) {
  const anchorKind = (str(row?.anchor_kind, 40) || 'none') as AnchorKind
  return {
    rwaId: str(row?.rwa_id, 20),
    logoUrl,
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
    // BESIDE the anchor, never in place of it.
    underlyingReference: underlyingReferenceRow(row),
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
      settings, scope: WRAPPER_SPREAD_SCOPE, anchorMeaning: ANCHOR_MEANING, referenceScope: REFERENCE_SCOPE,
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

  // Logos, joined HERE rather than by the surface. Two bounded reads of rows we
  // already hold, for the ids this read is about to return and no others, so the
  // client makes one request for the whole board instead of one per row. A
  // failed logo read is not a failed board: it leaves every image null, which is
  // the monogram the surface drew before, and it is not reported as a reason.
  const cryptoIds = [...new Set(tokenRead.rows.map((row) => str(row?.crypto_id, 20)).filter((v): v is string => !!v))]
  const [assetLogoRead, tokenLogoRead] = await Promise.all([
    ids.length
      ? readRows(() => db.from(PROFILE_TABLE).select('rwa_id,logo_url').in('rwa_id', ids).limit(ROW_LIMIT))
      : Promise.resolve({ rows: [], reason: null }),
    cryptoIds.length
      ? readRows(() => db.from(CATALOGUE_TABLE).select('provider_id,cached_image_url,image_url,num_market_pairs,in_current_catalog')
          .eq('source_provider', 'coinmarketcap').in('provider_id', cryptoIds).limit(LOGO_CAP))
      : Promise.resolve({ rows: [], reason: null }),
  ])
  const assetLogos = new Map<string, string>()
  for (const row of assetLogoRead.rows) {
    const id = str(row?.rwa_id, 20)
    const url = image(row?.logo_url)
    if (id && url) assetLogos.set(id, url)
  }
  const tokenLogos = new Map<string, Logo>()
  // The same catalogue rows carry each wrapper's market pair count. Unlike a
  // logo, a failed read here IS stated: per wrapper, as an unassessed coverage
  // with a reason, and once on the payload.
  const tokenMarkets = new Map<string, CatalogueMarket>()
  for (const row of tokenLogoRead.rows) {
    const id = str(row?.provider_id, 20)
    if (!id) continue
    tokenLogos.set(id, { cached: image(row?.cached_image_url), original: image(row?.image_url) })
    tokenMarkets.set(id, { marketPairs: num(row?.num_market_pairs), inCurrentCatalog: bool(row?.in_current_catalog) })
  }
  const catalogueRead = !tokenLogoRead.reason

  type CoveredWrapper = ReturnType<typeof wrapperRow> & {
    marketPairs: number | null; inCurrentCatalog: boolean | null
    coverageState: MarketCoverage | null; coverageReason: string | null
  }
  const tokensByAsset = new Map<string, CoveredWrapper[]>()
  for (const row of tokenRead.rows) {
    const id = str(row?.rwa_id, 20)
    if (!id) continue
    const cryptoId = str(row?.crypto_id, 20)
    const token = wrapperRow(row, (cryptoId && tokenLogos.get(cryptoId)) || null)
    const market = (cryptoId && tokenMarkets.get(cryptoId)) || null
    const coverage = marketCoverage(token, market, catalogueRead)
    tokensByAsset.set(id, [...(tokensByAsset.get(id) || []), {
      ...token,
      marketPairs: market?.marketPairs ?? null,
      inCurrentCatalog: market?.inCurrentCatalog ?? null,
      coverageState: coverage.state,
      coverageReason: coverage.reason,
    }])
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

  const all = rankAssets(current.map((row) => {
    const id = str(row?.rwa_id, 20) ?? ''
    const tokens = tokensByAsset.get(id) || []
    const asset = wrapperAssetRow(row, tokens, assetLogos.get(id) ?? underlyingFallbackLogo(row?.asset_type, tokens))
    // Which wrapper to name for three different questions, computed from the
    // same rows the table shows, so the picks and the table cannot disagree.
    return { ...asset, picks: wrapperPicks(asset) }
  }))
  const rows = all.slice(0, limit)

  const reconciliation = rows
    .filter((row) => row.reconcileState !== 'not_comparable')
    .map((row) => ({
      rwaId: row.rwaId, symbol: row.symbol, name: row.name, assetType: row.assetType, logoUrl: row.logoUrl,
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
    // What the stock reference is and is not, stated once for the whole board.
    referenceScope: REFERENCE_SCOPE,
    pickRules: PICK_RULES,
    // Null when every wrapper's market coverage was assessed. A failed catalogue
    // read leaves each wrapper's coverage null with a reason, and says so here.
    marketCoverageReason: catalogueRead ? null : tokenLogoRead.reason,
    schedule: RWA_WRAPPER_CAPTURE_SCHEDULE,
    // The two endpoints behind every figure on this surface, named on the payload
    // so the surface states them rather than restating them in JSX.
    endpoints: [
      { capability: 'rwaQuotes', path: '/v5/real-world-assets/quotes/latest', supplies: 'wrapper_prices' },
      { capability: 'rwaList', path: '/v5/real-world-assets/assets/list', supplies: 'asset_level_value' },
    ],
    asOf,
    // CoinMarketCap's own last_updated on the quotes this capture read. The RWA
    // quotes refresh less often than the lane runs (twice a day in the 22 and 23
    // Sep 2026 captures, at 08:45:59 and 20:45:59 UTC), so the 14:00 capture can
    // hold prices observed at 08:45. The surface states both times.
    pricesObservedAt: rows.map((row) => row.observedAt).filter((v): v is string => !!v).sort().at(-1) ?? null,
    coverage: { from: stamps[0] ?? null, to: asOf, count: rows.length, truncated: assetRead.rows.length >= ASSET_CAP || tokenRead.rows.length >= TOKEN_CAP || all.length > rows.length },
    reason: assetRead.reason || tokenRead.reason,
    generatedAt: new Date(at(now)).toISOString(),
  }
}

/** The picks for ONE asset, named by its RWA id or by any one of its wrappers'
 * CoinMarketCap ids. Served from the same newest-hour read as the board, so the
 * page and an agent asking about the same asset read the same capture.
 *
 * An asset outside the board's bounded read (it keeps the 60 widest-dispersion
 * assets of the newest hour) is answered as `not_in_capture` with a reason, never
 * as an asset that has no wrappers. */
// deno-lint-ignore no-explicit-any
export async function readRwaWrapperPicks(db: any, params: { rwaId?: unknown; cryptoId?: unknown } = {}, now: Date | number = Date.now()): Promise<ViewResult> {
  const wantId = (v: unknown) => { const s = String(v ?? '').trim(); return /^[1-9][0-9]{0,11}$/.test(s) ? s : null }
  const rwaId = wantId(params.rwaId)
  const cryptoId = wantId(params.cryptoId)
  const base = { view: 'rwa_wrapper_picks', rwaId, cryptoId, pickRules: PICK_RULES, generatedAt: new Date(at(now)).toISOString() }
  if (!rwaId && !cryptoId) {
    return { ...base, state: 'no_asset_selected', asset: null, picks: null, asOf: null, coverage: emptyCoverage(), reason: 'no_asset_selected' }
  }
  const board = await readRwaWrappers(db, { limit: ROW_LIMIT }, now)
  // deno-lint-ignore no-explicit-any
  const rows = (board.rows as any[]) || []
  const row = rows.find((r) => (rwaId && r.rwaId === rwaId)
    // deno-lint-ignore no-explicit-any
    || (!rwaId && cryptoId && r.tokens.some((t: any) => t.cryptoId === cryptoId))) || null
  if (!row) {
    return {
      ...base, state: board.asOf ? 'not_in_capture' : 'not_captured', asset: null, picks: null,
      asOf: board.asOf, coverage: board.coverage, reason: board.reason || null,
      schedule: RWA_WRAPPER_CAPTURE_SCHEDULE,
    }
  }
  return {
    ...base, state: 'ready',
    asset: {
      rwaId: row.rwaId, symbol: row.symbol, name: row.name, assetType: row.assetType,
      anchorKind: row.anchorKind, anchorPrice: row.anchorPrice, anchorReason: row.anchorReason,
      anchorMeaning: row.anchorMeaning, anchorObservedAt: row.anchorObservedAt,
      observedAt: row.observedAt, wrapperCount: row.wrapperCount,
      // The listed share's price beside the anchor, where one applies.
      underlyingReference: row.underlyingReference,
    },
    picks: row.picks,
    endpoints: board.endpoints,
    asOf: board.asOf,
    coverage: { from: board.asOf, to: board.asOf, count: 1 },
    reason: board.reason || null,
  }
}

/** Integration surface consumed by `intel-capture/index.ts`, keyed by view name. */
export const RWA_WRAPPER_CAPTURE_VIEWS: Record<string, (
  // deno-lint-ignore no-explicit-any
  db: any, body: Record<string, unknown>, now: number
) => Promise<ViewResult>> = {
  rwa_wrappers: (db, body, now) => readRwaWrappers(db, body, now),
  rwa_wrapper_picks: (db, body, now) => readRwaWrapperPicks(db, { rwaId: body.rwaId ?? body.rwa_id, cryptoId: body.cryptoId ?? body.crypto_id }, now),
}
