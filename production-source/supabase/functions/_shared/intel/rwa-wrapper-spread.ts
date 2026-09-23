// Investor Intel: wrapper premium, discount and dispersion for a tokenised
// real-world asset.
//
// THE QUESTION. One real-world asset - Nvidia shares, gold, a Treasury fund - is
// wrapped by several tokens from several issuers, and those tokens do not trade
// at the same price. This module turns CoinMarketCap's per-asset token list into
// a premium or discount per wrapper, the dispersion across the wrappers of one
// asset, and the cheapest route into that asset.
//
// THE ANCHOR IS THE WHOLE ARGUMENT, so it is named on every row.
//
//   published NAV          The fund's own net asset value, read on chain from its
//                          Chainlink feed by the keyless `rwa_yield` lane and
//                          stored in `intel_rwa_nav_observations`. This is the
//                          only anchor that is independent of the wrappers.
//
//   liquid wrapper median  The volume-weighted median price of the wrappers that
//                          pass the liquidity gate: the price at or below which
//                          half of the reported 24-hour volume trades. It is
//                          derived FROM the wrappers, which is stated in those
//                          words on the surface rather than dressed up as an
//                          independent reference.
//
// A wrapper below the volume floor is still a ROW carrying its premium. It is
// only kept OUT of the anchor, and says so. Dropping it would hide exactly the
// wrappers a reader most needs to be warned about.
//
// TWO GUARDS, BOTH OF WHICH EXIST BECAUSE THE NAIVE VERSION IS WRONG. The two
// ideas below are not ours; both have been demonstrated before by other people
// working on tokenised-asset data, and both are implemented here from first
// principles because a spread computed without them is not a spread.
//
//   1. THE UNIT GUARD. A gold wrapper may be denominated in grams rather than
//      troy ounces (31.1034768 g). Comtech Gold trades near $139 while PAX Gold
//      and Tether Gold trade near $4,360: subtracting one from the other would
//      publish a 97 percent discount that does not exist. A wrapper whose price
//      sits at the troy-ounce ratio is NORMALISED and labelled; a wrapper off by
//      anything else beyond a sane band is EXCLUDED and labelled, because an
//      unexplained 30x price gap is far more likely to be a different instrument
//      than a real arbitrage.
//
//   2. THE TOTAL-RETURN GUARD. A wrapper that accrues its yield inside the token
//      price climbs away from its peers forever. Ondo US Dollar Yield sat at
//      $1.1465 against dollar peers on 2026-09-20, which a naive engine reports
//      as a permanent 14.65 percent premium, month after month. Where a token is
//      recorded in the accrual register below, the gap is reported as an ACCRUAL
//      gap with its own state and is never called a premium, and the token is
//      kept out of the anchor and out of the cheapest route.
//
// Pure. No database, no network, no clock of its own: every time value is passed
// in. Field names are read from the shapes the provider actually returns (see
// `rwa-wrapper-spread.test.ts`, whose fixtures are built from the live
// `/v5/real-world-assets/quotes/latest` and `/assets/list` response schemas and
// from cached payloads read with SQL).

// ─── Constants, every one of them a recorded judgement ────────────────────────

/** Grams in a troy ounce. The exact figure, not an approximation. */
export const TROY_OUNCE_GRAMS = 31.1034768

/** How close to the troy-ounce ratio a price has to sit before the wrapper is
 * treated as denominated in the other weight unit. Checked on 2026-09-20:
 * Comtech Gold at $139.43 against a $4,363.25 peer median is 0.60 percent off
 * the exact ratio, so a 6 percent window identifies the unit without admitting a
 * wrapper that merely happens to be cheap. */
export const UNIT_RATIO_TOLERANCE = 0.06

/** How far from the peer median a price may sit and still be accepted as the
 * same unit. Two wrappers of one share do not trade 25 percent apart; a gap that
 * wide is a unit or an entity problem, and calling it a premium would be worse
 * than showing nothing. Outside this band, and not explained by the weight
 * ratio, the wrapper is excluded and labelled `unit_not_established`. */
export const UNIT_BAND = 0.25

/** Reported 24-hour volume, in USD, below which a wrapper is shown but kept out
 * of the anchor. Measured on 2026-09-20 across the gold wrappers: Tether Gold
 * $70.9m, PAX Gold $60.1m, Comtech Gold $0.92m, Matrixdock Gold $0.43m, and
 * several wrappers at zero. A floor of $250k excludes a dead quote while keeping
 * a real secondary wrapper inside the anchor. */
export const LIQUIDITY_FLOOR_USD = 250_000

/** A median needs at least two members to be anything other than the one
 * wrapper's own price. With fewer, the anchor is refused rather than made
 * circular. */
export const ANCHOR_MIN_LIQUID = 2

/** The reconciliation band. Inside it the two endpoints are reported as
 * agreeing; outside it the row is flagged. Neither state says the provider is
 * wrong: it says the two endpoints disagree. */
export const RECONCILE_BAND_LOW = 0.85
export const RECONCILE_BAND_HIGH = 1.15

/** A NAV anchor is only used when the fund's own feed is fresh. A stale NAV is a
 * worse anchor than the live wrappers, so the row falls back and says so. */
export const NAV_ANCHOR_STALENESS = ['fresh'] as const

export const ANCHOR_KINDS = ['published_nav', 'liquid_wrapper_median', 'none'] as const
export type AnchorKind = typeof ANCHOR_KINDS[number]

export const WRAPPER_STATES = [
  'liquid', 'too_thin_to_anchor', 'volume_not_reported', 'no_price',
  'unit_not_established', 'accrues_in_price', 'derivative_reference',
] as const
export type WrapperState = typeof WRAPPER_STATES[number]

/**
 * CoinMarketCap lists a DERIVATIVE price among an asset's tokens: issuer "NA
 * (Derivatives)" (one issuer id for all of them), a name ending "(Derivatives)"
 * and a market cap of 0. It is a perpetual or index price, not a token anyone
 * holds or redeems, so it is never a wrapper. On 2026-09-23 the capture held 41
 * of them, and 5 were anchor members (MSTR, SNDK, INTC, NVDA, HOOD), pulling the
 * liquid-wrapper median toward a contract price. Such a row is kept and labelled,
 * with its gap to the anchor for information, and is never an anchor member, a
 * widest premium or discount, a pick, a dispersion input or a wrapper count.
 */
export const CMC_DERIVATIVES_ISSUER_ID = '695e11f774b54210f3b95dc3'
export function isDerivativeReference(token: { issuerId?: unknown; issuerName?: unknown; name?: unknown } | null | undefined): boolean {
  if (!token) return false
  if (String(token.issuerId ?? '') === CMC_DERIVATIVES_ISSUER_ID) return true
  if (/\(derivatives\)\s*$/i.test(String(token.issuerName ?? '').trim())) return true
  return /\(derivatives\)\s*$/i.test(String(token.name ?? '').trim())
}

export const UNIT_STATES = ['consistent', 'normalised_troy_ounce', 'normalised_gram', 'not_established', 'not_assessed'] as const
export type UnitState = typeof UNIT_STATES[number]

export const RECONCILE_STATES = ['agree', 'outside_band', 'not_comparable'] as const
export type ReconcileState = typeof RECONCILE_STATES[number]

/** What the premium figure does NOT mean. Stored on every asset row and rendered
 * beside the figure, because an executable arbitrage is exactly what a reader
 * will assume this is if nobody says otherwise. */
export const WRAPPER_SPREAD_SCOPE =
  'A premium or discount is the gap between one wrapper\'s reported price and the stated anchor for the same underlying asset. It is not a tradable arbitrage: it ignores redemption rights, minimum sizes, eligibility, custody, transfer restrictions, fees and the venue the quote came from. Wrappers of one asset are not interchangeable holdings.'

/** What the anchor is, in the reader's words. Keyed so the surface can translate
 * it rather than restating it in JSX. */
export const ANCHOR_MEANING: Record<AnchorKind, string> = {
  published_nav: 'The fund\'s own net asset value per share, published to its Chainlink feed and read on chain. It is independent of every wrapper price on this row.',
  liquid_wrapper_median: 'The volume-weighted median of the wrappers that passed the liquidity floor: the price at or below which half of the reported 24-hour volume trades. It is derived from the wrappers themselves, so a whole market moving together moves the anchor with it.',
  none: 'No anchor could be established for this asset, so no premium or discount is reported for its wrappers.',
}

/** The unit guard, applied only where the underlying is denominated by WEIGHT.
 * A 31x price gap between two wrappers of one metal is a unit; the same gap
 * between two wrappers of one share is not, and normalising it would invent a
 * price. Keyed on the RWA asset symbol as CoinMarketCap reports it, verified
 * against the live universe on 2026-09-20 (Gold rwa_id 1 / GOLD, Silver 5 /
 * SILVER, Palladium 16388 / XPD). */
export const WEIGHT_DENOMINATED_SYMBOLS = new Set(['GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'XAU', 'XAG', 'XPT', 'XPD'])

/** Wrappers that accrue their return INSIDE the token price.
 *
 * Keyed on the CoinMarketCap crypto id, never a ticker: in our own catalogue the
 * ticker `M` resolves to two assets that are neither the fund we mean, so a
 * ticker join here would mislabel a different token as accruing. Each entry
 * records the name the catalogue carried when it was added; the capture lane
 * re-verifies that name before applying the guard, so a repurposed id is
 * refused rather than silently exempted.
 *
 * Verified against `market_assets` on 2026-09-20: Ondo US Dollar Yield traded at
 * $1.1465 with dollar-denominated peers at $1.00, which is the whole reason this
 * register exists. It is short because CoinMarketCap publishes ids for very few
 * accumulating wrappers today; it grows as wrappers appear, and a token that is
 * not in it is reported as a plain premium. */
export const ACCRUAL_WRAPPERS: Record<string, { name: string; note: string }> = {
  '29256': {
    name: 'Ondo US Dollar Yield',
    note: 'The token price accrues the fund\'s yield, so it rises against a par-priced peer by design. The gap is an accrual, not a premium.',
  },
}

/** RWA assets whose anchor is a published net asset value rather than the
 * wrappers themselves, keyed on the CoinMarketCap RWA id.
 *
 * DELIBERATELY EMPTY, and that is a source fact rather than unfinished work.
 * Checked on 2026-09-20 against both stores: `/v5/real-world-assets/assets/list`
 * returns ZERO assets for `government_security` and `real_estate`, and
 * `market_assets` holds no CoinMarketCap row for any fund in
 * `rwa-yield-register.ts` (USTB, USTBL, JTRSY, VBILL, SAFO, WTGXX, EUTBL,
 * EURSAFO, JAAA, CRDYX, ACRED, BTCY). There is therefore no RWA id to map a NAV
 * feed onto today, and inventing one from a ticker is the wrong-entity failure
 * the yield register was built to avoid.
 *
 * Both `symbol` and `name` are re-verified against the provider's own row before
 * the NAV is used, so a repurposed RWA id falls back to the wrapper median with
 * a stated reason instead of borrowing another fund's NAV. */
export const RWA_NAV_ANCHORS: Record<string, { feedKey: string; symbol: string; name: string }> = {}

// ─── Small helpers ────────────────────────────────────────────────────────────

const finite = (v: unknown): number | null => {
  if (v == null || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
/** A price has to be positive to be a price. Zero is not a cheap wrapper. */
const price = (v: unknown): number | null => { const n = finite(v); return n != null && n > 0 ? n : null }
/** A reported size may legitimately be zero, which is different from absent. */
const size = (v: unknown): number | null => { const n = finite(v); return n != null && n >= 0 ? n : null }
const text = (v: unknown, max = 200): string | null => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, max) : null }
const id = (v: unknown): string | null => (/^[1-9][0-9]{0,11}$/.test(String(v ?? '')) ? String(v) : null)

/** Plain median of a non-empty sorted-agnostic list. */
export function median(values: number[]): number | null {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (!list.length) return null
  const mid = Math.floor(list.length / 2)
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2
}

/** The price at or below which half the total weight sits.
 *
 * Weights are 24-hour volumes, so this is the price half the reported turnover
 * traded at or under. Ties on price are pooled before the crossing is tested, so
 * two wrappers quoting the same price cannot produce two different answers
 * depending on input order. A zero total weight has no weighted median and
 * returns null rather than silently degrading to the plain median. */
export function volumeWeightedMedian(points: { price: number; weight: number }[]): number | null {
  const usable = points
    .filter((p) => Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.weight) && p.weight >= 0)
    .sort((a, b) => a.price - b.price)
  if (!usable.length) return null
  const total = usable.reduce((sum, p) => sum + p.weight, 0)
  if (!(total > 0)) return null
  let seen = 0
  for (let i = 0; i < usable.length; i++) {
    // Pool the whole tie group before testing, so order inside a tie is irrelevant.
    let j = i
    let group = 0
    while (j < usable.length && usable[j].price === usable[i].price) { group += usable[j].weight; j++ }
    seen += group
    if (seen * 2 >= total) return usable[i].price
    i = j - 1
  }
  return usable.at(-1)!.price
}

/** Basis points of `anchor`, signed: positive means the wrapper is dearer. */
export const bps = (value: number, anchor: number): number | null =>
  anchor > 0 && Number.isFinite(value) ? ((value - anchor) / anchor) * 10_000 : null

// ─── Provider shapes, read once and only here ─────────────────────────────────

export interface WrapperTokenInput {
  cryptoId: string | null
  symbol: string | null
  name: string | null
  issuerId: string | null
  issuerName: string | null
  /** As reported, in whatever unit the wrapper uses. */
  price: number | null
  marketCap: number | null
  volume24h: number | null
}

export interface WrapperAssetInput {
  rwaId: string
  symbol: string | null
  name: string | null
  assetType: string | null
  rwaRank: number | null
  /** Asset-level figures as the QUOTES endpoint reports them. */
  averageTokenizedPrice: number | null
  tokenizedMarketCap: number | null
  tokenizedVolume24h: number | null
  observedAt: string | null
  tokens: WrapperTokenInput[]
}

/** One `data.rwa_assets[]` row of `/v5/real-world-assets/quotes/latest`.
 *
 * The asset-level figures live on the USD entry of `quotes[]`, which
 * `cmcRows` has already folded onto `row.quote`; the bare row is read as a
 * fallback because the documented schema carries them in both places. The token
 * fields are `crypto_id`, `symbol`, `name`, `issuer_id`, `issuer_name`, `price`,
 * `market_cap` and `volume_24h`, verified against the endpoint reference on
 * 2026-09-20. NOTE the asset level says `tokenized_volume_24h` while the TOKEN
 * level says `volume_24h`: the previous audit found the asset-level field read
 * as `volume_24h`, which is why both are named explicitly here. */
// deno-lint-ignore no-explicit-any
export function wrapperAssetFromQuote(row: any): WrapperAssetInput | null {
  const rwaId = id(row?.rwa_id)
  if (!rwaId) return null
  const quote = row?.quote ?? {}
  const tokens: WrapperTokenInput[] = []
  const seen = new Set<string>()
  for (const token of (Array.isArray(row?.tokens) ? row.tokens : []).slice(0, 500)) {
    const cryptoId = id(token?.crypto_id)
    // A token with no stable id cannot be linked to a catalogue row or checked
    // against the accrual register, so it is not carried as a wrapper.
    if (!cryptoId || seen.has(cryptoId)) continue
    seen.add(cryptoId)
    tokens.push({
      cryptoId,
      symbol: text(token?.symbol, 50), name: text(token?.name, 200),
      issuerId: text(token?.issuer_id, 100), issuerName: text(token?.issuer_name, 200),
      price: price(token?.price), marketCap: size(token?.market_cap), volume24h: size(token?.volume_24h),
    })
  }
  return {
    rwaId,
    symbol: text(row?.symbol, 50), name: text(row?.name, 200), assetType: text(row?.asset_type, 40),
    rwaRank: (() => { const n = finite(row?.rwa_rank); return n != null && n > 0 ? Math.trunc(n) : null })(),
    averageTokenizedPrice: price(quote.average_tokenized_price ?? row?.average_tokenized_price),
    tokenizedMarketCap: size(quote.tokenized_market_cap ?? row?.tokenized_market_cap),
    tokenizedVolume24h: size(quote.tokenized_volume_24h ?? row?.tokenized_volume_24h),
    observedAt: text(quote.last_updated ?? row?.last_updated, 40),
    tokens,
  }
}

export interface AssetListFigures {
  rwaId: string
  symbol: string | null
  name: string | null
  assetType: string | null
  rwaRank: number | null
  hasTokens: boolean | null
  averageTokenizedPrice: number | null
  tokenizedMarketCap: number | null
  tokenizedVolume24h: number | null
  observedAt: string | null
}

/** One `data.rwa_assets[]` row of `/v5/real-world-assets/assets/list`.
 *
 * This endpoint returns NO `tokens` array: that is the reason the reconciliation
 * needs two endpoints at all. `tokenized_market_cap` here is the asset-level
 * figure the list prices the asset at, and a reported 0 is a real source zero
 * (Silver carried `tokenized_market_cap: 0` beside $265,523 of 24-hour volume on
 * 2026-09-14), so it is kept as 0 and never turned into a NULL. */
// deno-lint-ignore no-explicit-any
export function assetListFigures(row: any): AssetListFigures | null {
  const rwaId = id(row?.rwa_id)
  if (!rwaId) return null
  const quote = row?.quote ?? {}
  return {
    rwaId,
    symbol: text(row?.symbol, 50), name: text(row?.name, 200), assetType: text(row?.asset_type, 40),
    rwaRank: (() => { const n = finite(row?.rwa_rank); return n != null && n > 0 ? Math.trunc(n) : null })(),
    hasTokens: typeof row?.has_tokens === 'boolean' ? row.has_tokens : null,
    averageTokenizedPrice: price(quote.average_tokenized_price ?? row?.average_tokenized_price),
    tokenizedMarketCap: size(quote.tokenized_market_cap ?? row?.tokenized_market_cap),
    tokenizedVolume24h: size(quote.tokenized_volume_24h ?? row?.tokenized_volume_24h),
    observedAt: text(quote.last_updated ?? row?.last_updated, 40),
  }
}

// ─── The unit guard ───────────────────────────────────────────────────────────

export interface UnitVerdict {
  state: UnitState
  /** The price restated in the asset's own unit, or null where the unit could
   * not be established. */
  normalisedPrice: number | null
  /** What was multiplied in, so the figure can be reproduced by hand. */
  factor: number | null
  reason: string | null
}

/** Decide whether a wrapper price is in the same unit as its peers.
 *
 * `reference` is the plain median of the RAW peer prices, which is robust to one
 * odd wrapper in either direction. It is deliberately not the mean: with three
 * ounce wrappers and one gram wrapper, the mean sits between the units and
 * nothing matches it.
 *
 * `weightDenominated` gates the whole weight branch. Where the underlying is not
 * denominated by weight, a price far from its peers is reported as a unit that
 * could not be established, and is never rescaled by a metals constant. */
export function unitVerdict(
  rawPrice: number | null,
  reference: number | null,
  options: { weightDenominated: boolean } = { weightDenominated: false },
): UnitVerdict {
  if (rawPrice == null || rawPrice <= 0) return { state: 'not_assessed', normalisedPrice: null, factor: null, reason: 'no_price' }
  if (reference == null || reference <= 0) return { state: 'not_assessed', normalisedPrice: rawPrice, factor: 1, reason: 'no_peer_reference' }
  const ratio = rawPrice / reference
  if (Math.abs(ratio - 1) <= UNIT_BAND) return { state: 'consistent', normalisedPrice: rawPrice, factor: 1, reason: null }
  if (options.weightDenominated) {
    // The wrapper is priced per gram while its peers are priced per troy ounce.
    if (Math.abs(ratio * TROY_OUNCE_GRAMS - 1) <= UNIT_RATIO_TOLERANCE) {
      return { state: 'normalised_troy_ounce', normalisedPrice: rawPrice * TROY_OUNCE_GRAMS, factor: TROY_OUNCE_GRAMS, reason: null }
    }
    // The mirror case: the wrapper is priced per troy ounce while its peers, and
    // therefore the reference, are priced per gram.
    if (Math.abs(ratio / TROY_OUNCE_GRAMS - 1) <= UNIT_RATIO_TOLERANCE) {
      return { state: 'normalised_gram', normalisedPrice: rawPrice / TROY_OUNCE_GRAMS, factor: 1 / TROY_OUNCE_GRAMS, reason: null }
    }
  }
  return {
    state: 'not_established', normalisedPrice: null, factor: null,
    reason: options.weightDenominated ? 'price_matches_no_known_weight_unit' : 'price_far_from_peers',
  }
}

// ─── The anchor ───────────────────────────────────────────────────────────────

export interface NavAnchorInput {
  feedKey: string
  nav: number | null
  navObservedAt: string | null
  validationState: string | null
  staleness: string | null
  currency: string | null
}

export interface WrapperRow {
  cryptoId: string
  symbol: string | null
  name: string | null
  issuerId: string | null
  issuerName: string | null
  price: number | null
  normalisedPrice: number | null
  marketCap: number | null
  volume24h: number | null
  unitState: UnitState
  unitFactor: number | null
  state: WrapperState
  /** Non-null only where the state admits a premium. An accruing wrapper carries
   * `accrualGapBps` instead, so nothing downstream can render an accrual as a
   * premium by reading the wrong field. */
  premiumBps: number | null
  accrualGapBps: number | null
  /** Whether this wrapper contributed to the anchor. */
  inAnchor: boolean
  reason: string | null
}

export interface WrapperSpread {
  rwaId: string
  symbol: string | null
  name: string | null
  assetType: string | null
  rwaRank: number | null
  anchorKind: AnchorKind
  anchorPrice: number | null
  /** Where a NAV anchored the row: which feed, and the aggregator's own clock
   * for the round. Never our capture time. */
  anchorFeedKey: string | null
  anchorObservedAt: string | null
  anchorReason: string | null
  anchorMembers: number
  wrapperCount: number
  liquidCount: number
  thinCount: number
  /** Widest premium and widest discount among the wrappers that carry one. */
  widestPremiumBps: number | null
  widestPremiumCryptoId: string | null
  widestDiscountBps: number | null
  widestDiscountCryptoId: string | null
  /** Highest minus lowest anchor-eligible price, as basis points of the anchor. */
  dispersionBps: number | null
  /** Volume-weighted mean absolute deviation from the anchor, over the same
   * wrappers. A dead quote contributes nothing to it. */
  weightedSpreadBps: number | null
  cheapestCryptoId: string | null
  cheapestPremiumBps: number | null
  averageTokenizedPrice: number | null
  tokenizedMarketCap: number | null
  tokenizedVolume24h: number | null
  tokenMarketCapSum: number | null
  tokenMarketCapReported: number
  observedAt: string | null
  weightDenominated: boolean
  accrualCount: number
  unitNormalisedCount: number
  unitRefusedCount: number
  tokens: WrapperRow[]
}

/** Was this wrapper's id recorded as accruing, and does the name still agree?
 *
 * The name gate is the same discipline the yield register applies to its market
 * join: an id can be repurposed, and exempting whatever a row has become from
 * the premium calculation would quietly hide a real premium. A name that has
 * drifted is treated as NOT accruing and the row says so. */
export function accrualVerdict(cryptoId: string | null, name: string | null): { accruing: boolean; note: string | null; reason: string | null } {
  const entry = cryptoId ? ACCRUAL_WRAPPERS[cryptoId] : undefined
  if (!entry) return { accruing: false, note: null, reason: null }
  const seen = String(name ?? '').trim()
  if (!seen || seen !== entry.name) return { accruing: false, note: null, reason: 'accrual_name_mismatch' }
  return { accruing: true, note: entry.note, reason: null }
}

/** True when the NAV may anchor this asset: the feed validated, it is fresh, it
 * is denominated in USD (the wrapper prices are USD), and the provider's own
 * symbol and name still match what the map recorded. */
export function navAnchorUsable(
  asset: Pick<WrapperAssetInput, 'rwaId' | 'symbol' | 'name'>,
  nav: NavAnchorInput | null,
): { usable: boolean; reason: string | null } {
  const mapped = RWA_NAV_ANCHORS[asset.rwaId]
  if (!mapped) return { usable: false, reason: 'no_nav_feed_mapped' }
  if (!nav) return { usable: false, reason: 'nav_not_captured' }
  if (nav.feedKey !== mapped.feedKey) return { usable: false, reason: 'nav_feed_mismatch' }
  if (String(asset.symbol ?? '').trim() !== mapped.symbol) return { usable: false, reason: 'asset_symbol_mismatch' }
  if (String(asset.name ?? '').trim() !== mapped.name) return { usable: false, reason: 'asset_name_mismatch' }
  if (nav.validationState !== 'validated') return { usable: false, reason: 'nav_not_validated' }
  if ((nav.currency ?? 'USD') !== 'USD') return { usable: false, reason: 'nav_currency_not_usd' }
  if (!NAV_ANCHOR_STALENESS.includes(String(nav.staleness ?? '') as 'fresh')) return { usable: false, reason: 'nav_stale' }
  if (nav.nav == null || !(nav.nav > 0)) return { usable: false, reason: 'no_nav' }
  return { usable: true, reason: null }
}

/** The whole calculation for ONE underlying asset.
 *
 * Order matters and is the point of the function:
 *   1. the peer reference, from the raw prices;
 *   2. the unit guard per wrapper, which may rescale or exclude it;
 *   3. the accrual guard, which removes a wrapper from the premium question
 *      entirely rather than answering it wrongly;
 *   4. the liquidity gate, which decides anchor membership only;
 *   5. the anchor;
 *   6. the premium of every priced wrapper against it, thin ones included. */
export function wrapperSpread(
  asset: WrapperAssetInput,
  options: { nav?: NavAnchorInput | null; liquidityFloorUsd?: number } = {},
): WrapperSpread {
  const floor = Number.isFinite(Number(options.liquidityFloorUsd)) && Number(options.liquidityFloorUsd) >= 0
    ? Number(options.liquidityFloorUsd) : LIQUIDITY_FLOOR_USD
  const weightDenominated = WEIGHT_DENOMINATED_SYMBOLS.has(String(asset.symbol ?? '').toUpperCase())
  const reference = median(asset.tokens.map((t) => t.price).filter((v): v is number => v != null))

  // 1-4. Classify every wrapper.
  const rows: WrapperRow[] = asset.tokens.map((token) => {
    const unit = unitVerdict(token.price, reference, { weightDenominated })
    const accrual = accrualVerdict(token.cryptoId, token.name)
    let state: WrapperState
    let reason: string | null = null
    if (token.price == null) { state = 'no_price'; reason = 'price_not_reported' }
    else if (unit.state === 'not_established') { state = 'unit_not_established'; reason = unit.reason }
    else if (isDerivativeReference(token)) { state = 'derivative_reference'; reason = 'derivative_not_a_wrapper' }
    else if (accrual.accruing) { state = 'accrues_in_price'; reason = 'accrues_in_price' }
    else if (token.volume24h == null) { state = 'volume_not_reported'; reason = 'volume_not_reported' }
    else if (token.volume24h < floor) { state = 'too_thin_to_anchor'; reason = 'below_volume_floor' }
    else { state = 'liquid' }
    return {
      cryptoId: token.cryptoId!, symbol: token.symbol, name: token.name,
      issuerId: token.issuerId, issuerName: token.issuerName,
      price: token.price, normalisedPrice: unit.normalisedPrice,
      marketCap: token.marketCap, volume24h: token.volume24h,
      unitState: unit.state, unitFactor: unit.factor,
      state, premiumBps: null, accrualGapBps: null, inAnchor: false,
      reason: reason ?? accrual.reason,
    }
  }).filter((row) => !!row.cryptoId)

  // 5. The anchor. A published NAV wins where one is mapped, proved and fresh.
  const navCheck = navAnchorUsable(asset, options.nav ?? null)
  const members = rows.filter((row) => row.state === 'liquid' && row.normalisedPrice != null)
  const weighted = volumeWeightedMedian(members.map((row) => ({ price: row.normalisedPrice!, weight: row.volume24h ?? 0 })))
  let anchorKind: AnchorKind = 'none'
  let anchorPrice: number | null = null
  let anchorFeedKey: string | null = null
  let anchorObservedAt: string | null = null
  let anchorReason: string | null = null
  let anchorMembers = 0
  if (navCheck.usable) {
    anchorKind = 'published_nav'
    anchorPrice = options.nav!.nav
    anchorFeedKey = options.nav!.feedKey
    anchorObservedAt = options.nav!.navObservedAt
    anchorMembers = 1
  } else if (members.length >= ANCHOR_MIN_LIQUID && weighted != null) {
    anchorKind = 'liquid_wrapper_median'
    anchorPrice = weighted
    anchorObservedAt = asset.observedAt
    anchorMembers = members.length
    for (const row of members) row.inAnchor = true
    // Why the better anchor was not available, kept beside the one that was.
    anchorReason = navCheck.reason
  } else {
    anchorReason = members.length ? 'not_enough_liquid_wrappers' : rows.length ? 'no_liquid_wrapper' : 'no_wrappers_reported'
  }

  // 6. The premium of every PRICED wrapper, thin ones included. An accruing
  //    wrapper gets an accrual gap and never a premium.
  if (anchorPrice != null && anchorPrice > 0) {
    for (const row of rows) {
      if (row.normalisedPrice == null) continue
      const gap = bps(row.normalisedPrice, anchorPrice)
      if (gap == null) continue
      if (row.state === 'accrues_in_price') row.accrualGapBps = gap
      else row.premiumBps = gap
    }
  }

  // A derivative price is shown with its gap but is never the widest premium or discount.
  const premiums = rows.filter((row) => row.premiumBps != null && row.state !== 'derivative_reference')
  const dearest = premiums.reduce<WrapperRow | null>((best, row) => (best == null || row.premiumBps! > best.premiumBps! ? row : best), null)
  const cheapest = premiums.reduce<WrapperRow | null>((best, row) => (best == null || row.premiumBps! < best.premiumBps! ? row : best), null)
  // The cheapest ROUTE is only ever a wrapper someone could actually reach: it
  // must be liquid, unit-established and not accruing. A dead quote at half
  // price is not a route.
  const cheapestLiquid = premiums.filter((row) => row.state === 'liquid')
    .reduce<WrapperRow | null>((best, row) => (best == null || row.premiumBps! < best.premiumBps! ? row : best), null)

  const memberPrices = members.map((row) => row.normalisedPrice!)
  const dispersionBps = anchorPrice != null && anchorPrice > 0 && memberPrices.length >= ANCHOR_MIN_LIQUID
    ? ((Math.max(...memberPrices) - Math.min(...memberPrices)) / anchorPrice) * 10_000
    : null
  const weightBase = members.reduce((sum, row) => sum + (row.volume24h ?? 0), 0)
  const weightedSpreadBps = anchorPrice != null && anchorPrice > 0 && weightBase > 0
    ? members.reduce((sum, row) => sum + (row.volume24h ?? 0) * Math.abs(bps(row.normalisedPrice!, anchorPrice) ?? 0), 0) / weightBase
    : null

  const reportedCaps = rows.map((row) => row.marketCap).filter((v): v is number => v != null)

  return {
    rwaId: asset.rwaId, symbol: asset.symbol, name: asset.name, assetType: asset.assetType, rwaRank: asset.rwaRank,
    anchorKind, anchorPrice, anchorFeedKey, anchorObservedAt, anchorReason, anchorMembers,
    // Wrappers only: a derivative price is not a wrapper, so it never makes a
    // single-wrapper asset look like a multi-wrapper one.
    wrapperCount: rows.filter((row) => row.state !== 'derivative_reference').length,
    liquidCount: rows.filter((row) => row.state === 'liquid').length,
    thinCount: rows.filter((row) => row.state === 'too_thin_to_anchor' || row.state === 'volume_not_reported').length,
    widestPremiumBps: dearest?.premiumBps ?? null,
    widestPremiumCryptoId: dearest?.cryptoId ?? null,
    widestDiscountBps: cheapest?.premiumBps ?? null,
    widestDiscountCryptoId: cheapest?.cryptoId ?? null,
    dispersionBps, weightedSpreadBps,
    cheapestCryptoId: cheapestLiquid?.cryptoId ?? null,
    cheapestPremiumBps: cheapestLiquid?.premiumBps ?? null,
    averageTokenizedPrice: asset.averageTokenizedPrice,
    tokenizedMarketCap: asset.tokenizedMarketCap,
    tokenizedVolume24h: asset.tokenizedVolume24h,
    // Summed over the wrappers that REPORTED a cap. A null is never a zero here:
    // an asset where no wrapper reported one has no sum at all, which the
    // reconciliation reads as "not comparable" rather than as a disagreement.
    tokenMarketCapSum: reportedCaps.length ? reportedCaps.reduce((sum, v) => sum + v, 0) : null,
    tokenMarketCapReported: reportedCaps.length,
    observedAt: asset.observedAt,
    weightDenominated,
    accrualCount: rows.filter((row) => row.state === 'accrues_in_price').length,
    unitNormalisedCount: rows.filter((row) => row.unitState === 'normalised_troy_ounce' || row.unitState === 'normalised_gram').length,
    unitRefusedCount: rows.filter((row) => row.unitState === 'not_established').length,
    tokens: rows,
  }
}

// ─── Two-endpoint reconciliation ──────────────────────────────────────────────

export interface Reconciliation {
  state: ReconcileState
  /** Token sum divided by the list endpoint's asset-level figure. */
  ratio: number | null
  listMarketCap: number | null
  listCapturedAt: string | null
  listObservedAt: string | null
  tokenMarketCapSum: number | null
  quotesCapturedAt: string | null
  quotesObservedAt: string | null
  gapUsd: number | null
  reason: string | null
}

/** Compare what `/assets/list` prices an asset at against the sum of what
 * `/quotes/latest` says its own tokens are worth.
 *
 * This is a finding about the PROVIDER'S DATA and is worded that way: the two
 * endpoints disagree. Nothing here decides which one is right, and no state in
 * this function says the provider is wrong.
 *
 * The zero case is the one worth naming. A list figure of exactly 0 beside a
 * positive token sum is a real, reproducible disagreement (Silver carried
 * `tokenized_market_cap: 0` with reported volume), but the ratio would be
 * division by zero, so the row carries no ratio and a reason instead. Both sides
 * at zero is not a disagreement and not a measurement either: it is reported as
 * not comparable. */
export function reconcileTokenValue(input: {
  listMarketCap: number | null
  listCapturedAt?: string | null
  listObservedAt?: string | null
  tokenMarketCapSum: number | null
  quotesCapturedAt?: string | null
  quotesObservedAt?: string | null
}): Reconciliation {
  const base = {
    listMarketCap: input.listMarketCap ?? null,
    listCapturedAt: input.listCapturedAt ?? null,
    listObservedAt: input.listObservedAt ?? null,
    tokenMarketCapSum: input.tokenMarketCapSum ?? null,
    quotesCapturedAt: input.quotesCapturedAt ?? null,
    quotesObservedAt: input.quotesObservedAt ?? null,
  }
  const list = input.listMarketCap
  const sum = input.tokenMarketCapSum
  if (list == null) return { ...base, state: 'not_comparable', ratio: null, gapUsd: null, reason: 'list_value_not_reported' }
  if (sum == null) return { ...base, state: 'not_comparable', ratio: null, gapUsd: null, reason: 'no_wrapper_reported_a_value' }
  const gapUsd = sum - list
  if (list === 0) {
    if (sum === 0) return { ...base, state: 'not_comparable', ratio: null, gapUsd: 0, reason: 'both_endpoints_report_zero' }
    return { ...base, state: 'outside_band', ratio: null, gapUsd, reason: 'list_endpoint_reports_zero' }
  }
  const ratio = sum / list
  if (!Number.isFinite(ratio)) return { ...base, state: 'not_comparable', ratio: null, gapUsd, reason: 'ratio_not_computable' }
  const inBand = ratio >= RECONCILE_BAND_LOW && ratio <= RECONCILE_BAND_HIGH
  return { ...base, state: inBand ? 'agree' : 'outside_band', ratio, gapUsd, reason: inBand ? null : 'outside_band' }
}
