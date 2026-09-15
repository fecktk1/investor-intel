// Investor Intel — Markets detail coverage ring.
//
// EVERY asset page renders the SAME fixed section list. A section is never
// hidden because a source is missing: it is reported `unavailable` with the
// reason, or `not_applicable` when the section cannot exist for that identity
// (derivatives for an unlisted contract are unavailable; real-world-asset terms
// for a contract identity are not applicable). Pure and deterministic — it
// reads only the detail payload the handler already assembled, and makes no
// provider or database call of its own.

export type CoverageState = 'available' | 'unavailable' | 'not_applicable'
export interface CoverageSection { key: string; state: CoverageState; reason?: string }
export interface MarketCoverage { sections: CoverageSection[]; availableCount: number; totalCount: number }
export type MarketIdentityKind = 'cmc' | 'coingecko' | 'contract'

/** The fixed section list. Order is stable — the ring renders it as written. */
export const MARKET_COVERAGE_SECTIONS = [
  'quote', 'candles', 'venues', 'derivatives', 'liquidity', 'contract',
  'rwa', 'narrative', 'supply', 'metadata', 'signals', 'orderbook',
] as const

// deno-lint-ignore no-explicit-any
type Detail = Record<string, any>

const has = (v: unknown) => v != null && v !== ''
const rows = (v: unknown) => Array.isArray(v) && v.length > 0
/** Native canonical keys carry a `native` segment; contract keys carry an address. */
const isNativeKey = (key: unknown) => /(?:^|:)native(?::|$)/.test(String(key || ''))

export function marketCoverage(detail: Detail, opts: { identityKind: MarketIdentityKind; cmcId?: string | null }): MarketCoverage {
  const kind = opts.identityKind
  const cmcId = opts.cmcId ?? null
  const cexAvailable = detail?.cexCoverage === 'available'
  const cexReason = 'no_verified_exchange_pair'
  const contractAddress = detail?.contract?.address ?? null
  const canonicalKey = detail?.canonicalAssetKey ?? null
  const narrative = detail?.ecosystemNarratives || null

  const section = (key: string, state: CoverageState, reason?: string | null): CoverageSection =>
    state === 'available' ? { key, state } : { key, state, reason: reason || 'unavailable' }

  const sections: CoverageSection[] = [
    has(detail?.price)
      ? section('quote', 'available')
      : section('quote', 'unavailable', detail?.quoteReason || 'no_quote_observed'),
    rows(detail?.candles)
      ? section('candles', 'available')
      : section('candles', 'unavailable', detail?.chartReason || detail?.fallbackReason || 'no_price_history'),
    cexAvailable ? section('venues', 'available') : section('venues', 'unavailable', cexReason),
    // Derivatives (funding, open interest, perp venues) are sourced from
    // CoinMarketCap only; without that identity the section cannot be filled.
    cmcId ? section('derivatives', 'available') : section('derivatives', 'unavailable', 'no_coinmarketcap_listing'),
    has(detail?.dex?.liquidityUsd) || has(detail?.contract?.liquidityUsd) || has(detail?.onchain?.liquidity_usd)
      ? section('liquidity', 'available')
      : section('liquidity', 'unavailable', 'no_dex_pool_observed'),
    has(contractAddress) || (!isNativeKey(canonicalKey) && has(canonicalKey))
      ? section('contract', 'available')
      : isNativeKey(canonicalKey)
        ? section('contract', 'not_applicable', 'native_asset')
        : section('contract', 'unavailable', 'no_contract_address'),
    // A pasted contract has no issuer, prospectus or redemption terms to review.
    kind === 'contract'
      ? section('rwa', 'not_applicable', 'contract_identity')
      : section('rwa', 'unavailable', 'no_rwa_classification'),
    narrative?.status === 'available' && (rows(narrative?.asset_narratives) || rows(narrative?.ecosystem_narratives))
      ? section('narrative', 'available')
      : section('narrative', 'unavailable', 'no_narrative_coverage'),
    has(detail?.marketCap?.circulating_supply)
      ? section('supply', 'available')
      : section('supply', 'unavailable', 'no_supply_data'),
    has(detail?.displayName) || has(detail?.imageUrl)
      ? section('metadata', 'available')
      : section('metadata', 'unavailable', 'no_asset_metadata'),
    has(detail?.signal)
      ? section('signals', 'available')
      : section('signals', 'unavailable', cexAvailable ? 'no_market_signal' : cexReason),
    has(detail?.orderbook)
      ? section('orderbook', 'available')
      : section('orderbook', 'unavailable', cexAvailable ? 'no_orderbook_snapshot' : cexReason),
  ]

  return { sections, availableCount: sections.filter((s) => s.state === 'available').length, totalCount: sections.length }
}
