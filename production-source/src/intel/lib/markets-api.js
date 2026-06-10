// Investor Intel — Markets page client. Reads the exchange market intelligence
// layer (latest/cached tables only) via the intel-markets edge function.
// Pagination-first: pass { page, limit, sort, search, chain, provider,
// signalDirection, marketCapAvailability, watchlistOnly }.
export async function loadMarkets(supabase, orgId, params = {}) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, ...params } })
  if (error) throw new Error(error.message || 'markets_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Degen (memecoin) terminal list. Reads memecoin_latest_tokens via intel-degen
// (cache-only). Params: { page, limit, sort, search, chain, bucket, riskMax, minLiquidity }.
export async function loadDegenMarkets(supabase, orgId, params = {}) {
  const { data, error } = await supabase.functions.invoke('intel-degen', { body: { orgId, ...params } })
  if (error) throw new Error(error.message || 'degen_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Lazy per-token enrichment (on open / explicit). Free DexScreener refresh +
// gated Birdeye; writes back to memecoin_latest_tokens. Degrades silently.
export async function enrichDegenToken(supabase, chain, address, force = false) {
  try {
    const { data, error } = await supabase.functions.invoke('degen-token-enrich', { body: { chain, address, force } })
    if (error || data?.error) return null
    return data
  } catch { return null }
}

// Free cached Degen signals for a single memecoin — direct RLS read of
// memecoin_latest_tokens (authenticated read). Powers the DegenSignalsCard so a
// synthetic (not-yet-watchlisted) contract page is useful immediately. Returns
// null on miss/error so the caller degrades silently.
export async function loadDegenToken(supabase, chain, address) {
  if (!chain || !address) return null
  try {
    const { data } = await supabase.from('memecoin_latest_tokens').select('*').eq('chain', chain).eq('token_address', address).maybeSingle()
    return data || null
  } catch { return null }
}

// Global cached token/project profile (M5). Flexible identifiers; returns the
// cached profile instantly and enqueues a background refresh when stale.
export async function loadTokenProfile(supabase, ident = {}) {
  try {
    const { data, error } = await supabase.functions.invoke('token-profile-get', { body: ident })
    if (error || data?.error) return null
    return data
  } catch { return null }
}

// Full single-asset detail (signal + WHY factors + per-provider reads + market
// cap + spread + rollups + RAG memory + on-demand candles) for ANY exchange
// symbol. Powers /intel/markets/:symbol.
export async function loadMarketDetail(supabase, orgId, symbol) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, symbol } })
  if (error) throw new Error(error.message || 'market_detail_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Hydrate exchange market context for a set of asset symbols, keyed by uppercase
// symbol. Reads the cached latest tables directly (RLS authed read; no edge call,
// no live exchange calls). Returns {} on any error so callers degrade silently.
export async function loadMarketContextBySymbols(supabase, symbols = []) {
  const up = [...new Set((symbols || []).map((s) => String(s || '').toUpperCase().replace(/^\$/, '')).filter(Boolean))]
  if (!up.length) return {}
  try {
    const [{ data: sigs }, { data: tkrs }] = await Promise.all([
      supabase.from('exchange_latest_market_signals').select('normalized_symbol, direction, strength, confidence, title, summary, why_it_matters, provider_count, confirming_providers').in('normalized_symbol', up),
      supabase.from('exchange_latest_tickers').select('normalized_symbol, provider_symbol, price_change_pct_24h, volume_quote_24h, spread_pct').in('normalized_symbol', up),
    ])
    const bestT = {}
    for (const t of (tkrs || [])) { const k = String(t.normalized_symbol).toUpperCase(); if (!bestT[k] || (t.volume_quote_24h || 0) > (bestT[k].volume_quote_24h || 0)) bestT[k] = t }
    const out = {}
    for (const s of (sigs || [])) {
      const k = String(s.normalized_symbol).toUpperCase(); const t = bestT[k]; if (!t) continue
      out[k] = { direction: s.direction, strength: s.strength, confidence: s.confidence, title: s.title, summary: s.summary, whyItMatters: s.why_it_matters, providerCount: s.provider_count, confirmingProviders: s.confirming_providers, source: 'exchange-market', rawMetrics: { pair: t.provider_symbol, priceChangePercent24h: t.price_change_pct_24h, quoteVolume24h: t.volume_quote_24h, spreadPercent: t.spread_pct } }
    }
    return out
  } catch { return {} }
}

// Long-memory "year in review" for an asset (migration 228). Deterministic
// rollup series + major events + top narratives over the last ~15 months.
export async function loadAssetYearInReview(supabase, symbol, months = 15) {
  const { data, error } = await supabase.rpc('intel_asset_year_in_review', { p_symbol: String(symbol || '').toUpperCase().replace(/^\$/, ''), p_months: months })
  if (error) throw error
  return data
}
