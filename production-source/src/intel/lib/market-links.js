import { marketIdentityParams } from './asset-identity'

// Panels must retain the same asset as the screener row, even for duplicate tickers.
// Missing identity remains readable; it must not silently become a symbol lookup.
export function marketPanelHref(row) {
  if (!row) return null
  const symbol = row.symbol || row.normalizedSymbol || row.providerId
  if (symbol != null && row.sourceProvider && row.providerId != null) {
    return `/intel/markets/${encodeURIComponent(symbol)}${marketIdentityParams(row)}`
  }
  return row.canonicalAssetKey ? `/intel/asset/${encodeURIComponent(row.canonicalAssetKey)}` : null
}
