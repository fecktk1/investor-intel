import { loadTokenChart } from './chart-api'
import { loadMarketCandleSnapshot } from './markets-api'
import { portfolioAssetChartRef } from './portfolio-markers'
import { epochMs } from './chart-history'
import { canonicalPortfolioKey } from './asset-identity'
import { thesisCanonicalKey } from './thesis-identity'

const WINDOWS = { '1H': 3600000, '12H': 43200000, '24H': 86400000, '3D': 259200000, '7D': 604800000, '1M': 2592000000, '3M': 7776000000, '6M': 15552000000, '1Y': 31536000000 }
const INTERVALS = { '1H': '1H', '12H': '1H', '24H': '1H', '3D': '4H', '7D': '4H', '1M': '1D', '3M': '1W', '6M': '1W', '1Y': '1W' }

export function thesisChartIdentity(thesis) {
  const canonicalKey = thesisCanonicalKey(thesis)
  const market = /^market:([^:]+):(.+)$/.exec(canonicalKey || '')
  if (market) return { kind: 'market', sourceProvider: market[1], providerId: market[2], symbol: thesis?.entity?.display_symbol || null }
  const ledger = portfolioAssetChartRef(canonicalPortfolioKey(canonicalKey))
  if (ledger) return { kind: 'token', ref: ledger.ref }
  if (thesis?.entity_id && canonicalKey && !canonicalKey.startsWith('symbol:')) return { kind: 'token', entityId: thesis.entity_id }
  return null
}

export async function loadThesisChart(supabase, orgId, thesis, range = '7D', now = Date.now()) {
  const identity = thesisChartIdentity(thesis)
  if (!identity) throw new Error('Resolve this thesis to an exact asset to view its chart.')
  if (identity.kind === 'market') return loadMarketCandleSnapshot(supabase, orgId, identity.symbol, range, { sourceProvider: identity.sourceProvider, providerId: identity.providerId })
  const response = await loadTokenChart(supabase, orgId, { entityId: identity.entityId, ref: identity.ref, timeframe: INTERVALS[range] || '1D', range })
  // Token providers expose intervals, not window selectors. Retain their true
  // timestamps and restrict the returned observations to the requested window.
  const start = now - (WINDOWS[range] || WINDOWS['7D'])
  return {...response,candles:(response?.candles || []).filter((c) => { const t = epochMs(c.t); return t != null && t >= start && t <= now })}
}
export async function loadThesisCandles(...args) {const result=await loadThesisChart(...args);return Array.isArray(result)?result:result?.candles||[]}
