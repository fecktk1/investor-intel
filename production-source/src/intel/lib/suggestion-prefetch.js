// The asset a highlighted Markets suggestion opens, read before it is opened.
//
// Opening a suggestion navigates to its EXACT address
// (/intel/markets/ETH?provider=coinmarketcap&id=1027), and the asset page reads
// that asset's detail through the shared navigation cache (MarketDetailCache),
// keyed by the provider identity alone. A deep link starts that read the moment
// the page mounts. Search and Enter started it only after Enter, so the time a
// visitor spent looking at the suggestion list was wasted, and under load that
// was the 9 seconds of "Loading asset observations" a reviewer watched.
//
// So the highlighted suggestion's detail is read into the same cache while the
// list is open: Enter then lands on a read already finished or already in
// flight, the same one the deep link would have made.
//
// DEMO ONLY. In the public demo that read is stored and cache-only data
// (intel-demo-read), so reading a row nobody opens spends nothing. For a member
// the same read goes to intel-markets, which may call a provider for the asset,
// so it is never made on a guess.

import { isIntelDemoActive } from '../demo/demo-mode'
import { loadMarketDetail } from './markets-api'

/** The asset page's read for a suggestion address, or null for any other href. */
export function suggestionDetailTarget(href) {
  if (typeof href !== 'string' || !href.startsWith('/intel/markets/')) return null
  let url
  try { url = new URL(href, 'http://intel.invalid') } catch { return null }
  const match = url.pathname.match(/^\/intel\/markets\/([^/]+)$/)
  const sourceProvider = url.searchParams.get('provider')
  const providerId = url.searchParams.get('id')
  if (!match || !sourceProvider || !providerId) return null
  let symbol
  try { symbol = decodeURIComponent(match[1]) } catch { return null }
  // The asset page reads its route symbol upper-cased (MarketAssetPage routeSymbol).
  return { symbol: symbol.toUpperCase(), identity: { sourceProvider, providerId } }
}

/**
 * Read a highlighted suggestion's detail into the navigation cache. Returns true
 * when a read was started (or an existing one reused). Never throws.
 */
export function prefetchSuggestion({ row, cache, supabase, orgId, demo = isIntelDemoActive(), load = loadMarketDetail }) {
  if (!demo || !cache || !supabase || !orgId) return false
  const target = suggestionDetailTarget(row?.href)
  if (!target) return false
  try {
    const read = cache.read(target.identity, () => load(supabase, orgId, target.symbol, target.identity))
    Promise.resolve(read).catch(() => {})
    return true
  } catch { return false }
}
