import { loadMarkets } from './markets-api'
import { marketIdentityParams } from './asset-identity'
export async function searchIntelAssets(supabase, orgId, query, signal) {
  if (!orgId || query.trim().length < 2) return []
  const data = await loadMarkets(supabase, orgId, { search: query.trim().slice(0, 100), limit: 10, page: 0, provider: 'auto', sort: 'market_cap' }, { signal })
  if (!Array.isArray(data?.rows)) throw new Error('Asset search returned an invalid response. Try again.')
  return data.rows.filter(row => row.sourceProvider && row.providerId != null).slice(0, 10).map(row => ({
    to: `/intel/markets/${encodeURIComponent(row.symbol || row.providerId)}${marketIdentityParams(row)}`,
    label: `${row.displayName || row.symbol} · ${row.symbol || ''}`,
    description: `${row.chain || 'Market-wide asset'} · ${row.sourceProvider} · ID ${row.providerId}`,
    group: 'Assets',
  }))
}
