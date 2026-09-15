// Investor Intel — token chart client.
import {chartSeriesResponse} from '../../../supabase/functions/_shared/intel/chart-series-contract'
export async function loadTokenChart(supabase, orgId, { entityId = null, ref = null, timeframe = '1D', range = null } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-token-chart', { body: { orgId, entityId, ref, timeframe, ...(range?{range}:{}) } })
  if (error) throw new Error(error.message || 'chart_failed')
  if (data?.error) throw new Error(data.error)
  const series=chartSeriesResponse(data)
  return {...data,candles:series.candles,capture:data?.captureProof?{proof:data.captureProof,bars:series.candles}:null,chartSource:data?.chartSource||{...series.source,servedAt:null},coverage:data?.coverage||series.coverage}
}

export async function loadWalletPortfolio(supabase, orgId, { entityId = null, ref = null } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-wallet', { body: { orgId, entityId, ref } })
  if (error) throw new Error(error.message || 'wallet_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export async function loadDefiMetrics(supabase, orgId, { entityId = null, ref = null } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-defi-metrics', { body: { orgId, entityId, ref } })
  if (error) throw new Error(error.message || 'defi_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

export async function loadDefiBrowse(supabase, orgId, { chain = 'solana', view = 'vaults' } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-defi-browse', { body: { orgId, chain, view } })
  if (error) throw new Error(error.message || 'defi_browse_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Mirror of the org-wide Kamino universe (latest snapshot per vault across all
// workspaces, ranked by TVL) — so the DeFi page is populated from the jump with
// zero new Kamino calls. intel_defi_universe is SECURITY DEFINER (public data).
export async function loadDefiUniverse(supabase, { limit = 60 } = {}) {
  const { data, error } = await supabase.rpc('intel_defi_universe', { p_limit: limit })
  if (error) throw error
  return data || []
}
