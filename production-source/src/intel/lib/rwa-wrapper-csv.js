// The wrapper board as a CSV: one row per WRAPPER, with its asset's columns
// repeated on every row, in the order the reader has the board sorted.
//
// Licence rule (plan feature 7): a column marked `cmcRaw: true` carries a figure
// CoinMarketCap published, or one read straight off it (a price restated per
// troy ounce is still their price; a liquid-wrapper median IS one wrapper's
// price; a market pair count is their count). downloadTableCsv blanks those
// cells unless the read's source policy allows export. Premiums, accrual gaps
// and dispersion are OUR arithmetic over those prices and always export, as do
// ids, states and reasons.

const num = value => {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
const flag = value => (typeof value === 'boolean' ? String(value) : null)

/** Where every figure in the file came from, written on every row. */
export const WRAPPER_CSV_SOURCE = 'CoinMarketCap /v5/real-world-assets/quotes/latest, stored by the Investor Intel wrapper capture; premiums are Investor Intel calculations'

/** One CSV row per wrapper, flattened from the board rows the reader sees.
 * `orderTokens` is the same function the expanded tables sort with, so the file
 * and the screen list wrappers in the same order. */
export function wrapperCsvRows(assets, { asOf = null, orderTokens = tokens => tokens } = {}) {
  const out = []
  for (const asset of Array.isArray(assets) ? assets : []) {
    const tokens = orderTokens(Array.isArray(asset?.tokens) ? asset.tokens : [])
    for (const token of tokens) out.push({ asset, token, captured_at: asOf, source: WRAPPER_CSV_SOURCE })
  }
  return out
}

export const WRAPPER_CSV_COLUMNS = [
  { key: 'captured_at', label: 'captured_at', value: r => r.captured_at ?? null },
  { key: 'source', label: 'source', value: r => r.source ?? null },
  { key: 'rwa_id', label: 'RWA id', value: r => r.asset?.rwaId ?? null },
  { key: 'asset_symbol', label: 'Asset symbol', value: r => r.asset?.symbol ?? null },
  { key: 'asset_name', label: 'Asset', value: r => r.asset?.name ?? null },
  { key: 'asset_type', label: 'Asset type', value: r => r.asset?.assetType ?? null },
  { key: 'anchor_kind', label: 'Anchor kind', value: r => r.asset?.anchorKind ?? null },
  { key: 'anchor_price_usd', label: 'Anchor price (USD)', cmcRaw: true, value: r => num(r.asset?.anchorPrice) },
  { key: 'anchor_reason', label: 'Anchor reason', value: r => r.asset?.anchorReason ?? null },
  { key: 'dispersion_bps', label: 'Dispersion (bps)', value: r => num(r.asset?.dispersionBps) },
  { key: 'weighted_spread_bps', label: 'Volume-weighted spread (bps)', value: r => num(r.asset?.weightedSpreadBps) },
  { key: 'cheapest_crypto_id', label: 'Cheapest liquid route id', value: r => r.asset?.cheapestCryptoId ?? null },
  { key: 'crypto_id', label: 'Wrapper CoinMarketCap id', value: r => r.token?.cryptoId ?? null },
  { key: 'symbol', label: 'Wrapper symbol', value: r => r.token?.symbol ?? null },
  { key: 'name', label: 'Wrapper', value: r => r.token?.name ?? null },
  { key: 'issuer', label: 'Issuer', value: r => r.token?.issuerName ?? null },
  { key: 'price_usd', label: 'Price (USD)', cmcRaw: true, value: r => num(r.token?.price) },
  { key: 'normalised_price_usd', label: 'Price in the asset unit (USD)', cmcRaw: true, value: r => num(r.token?.normalisedPrice) },
  { key: 'premium_bps', label: 'Premium to anchor (bps)', value: r => num(r.token?.premiumBps) },
  { key: 'accrual_gap_bps', label: 'Accrual gap (bps)', value: r => num(r.token?.accrualGapBps) },
  { key: 'volume_24h_usd', label: '24h volume (USD)', cmcRaw: true, value: r => num(r.token?.volume24h) },
  { key: 'market_cap_usd', label: 'Market cap (USD)', cmcRaw: true, value: r => num(r.token?.marketCap) },
  { key: 'wrapper_state', label: 'Wrapper state', value: r => r.token?.state ?? null },
  { key: 'unit_state', label: 'Unit', value: r => r.token?.unitState ?? null },
  { key: 'in_anchor', label: 'In anchor', value: r => flag(r.token?.inAnchor) },
  { key: 'state_reason', label: 'State reason', value: r => r.token?.reason ?? null },
  { key: 'market_coverage', label: 'Market coverage', value: r => r.token?.coverageState ?? null },
  { key: 'market_coverage_reason', label: 'Market coverage reason', value: r => r.token?.coverageReason ?? null },
  { key: 'market_pairs', label: 'Market pairs', cmcRaw: true, value: r => num(r.token?.marketPairs) },
  // The listed share's price from a Chainlink on-chain feed, not a CoinMarketCap
  // figure, and the gap to it is our arithmetic, so none of these is gated.
  // A gap inside the feed's band is flagged: it is not distinguishable from zero.
  { key: 'underlying_ticker', label: 'Underlying ticker', value: r => r.asset?.underlyingReference?.ticker ?? null },
  { key: 'underlying_ref_state', label: 'Stock reference state', value: r => r.asset?.underlyingReference?.state ?? null },
  { key: 'underlying_ref_price_usd', label: 'Stock reference price (USD, Chainlink)', value: r => num(r.asset?.underlyingReference?.price) },
  { key: 'underlying_ref_feed', label: 'Stock reference feed', value: r => r.asset?.underlyingReference?.feed ?? null },
  { key: 'underlying_ref_network', label: 'Stock reference network', value: r => r.asset?.underlyingReference?.network ?? null },
  { key: 'underlying_ref_band_pct', label: 'Feed update band (%)', value: r => num(r.asset?.underlyingReference?.deviationPct) },
  { key: 'underlying_ref_observed_at', label: 'Stock reference updated at', value: r => r.asset?.underlyingReference?.observedAt ?? null },
  { key: 'underlying_ref_session', label: 'US session when compared', value: r => r.asset?.underlyingReference?.session ?? null },
  { key: 'vs_stock_bps', label: 'Gap to stock (bps)', value: r => num(r.token?.underlyingRefBps) },
  { key: 'vs_stock_within_band', label: 'Gap inside feed band', value: r => flag(r.token?.underlyingRefWithinBand) },
]
