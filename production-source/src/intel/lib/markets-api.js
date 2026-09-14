// Investor Intel — Markets page client. Reads the exchange market intelligence
// layer (latest/cached tables only) via the intel-markets edge function.
// Pagination-first: pass { page, limit, sort, search, chain, provider,
// signalDirection, marketCapAvailability, watchlistOnly }.
export async function loadMarkets(supabase, orgId, params = {}, { signal } = {}) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, ...params }, ...(signal ? { signal } : {}) })
  if (error) throw new Error(error.message || 'markets_failed')
  if (data?.error) throw new Error(data.error)
  return data
}

// Global cached observations retain the clock of the selected field, not a combined age.
export async function loadMarketMacro(supabase) {
  const { data, error } = await supabase.from('market_macro_available')
    .select('total_market_cap_usd,total_volume_24h_usd,market_cap_change_24h_pct,btc_dominance_pct,eth_dominance_pct,stablecoin_market_cap_usd,defi_market_cap_usd,as_of')
    .eq('snapshot_kind', 'global').order('as_of', { ascending: false }).limit(4)
  if (error) throw error
  if (!Array.isArray(data)) throw new Error('Invalid global market response')
  if (!data.length) return null
  const result = { fieldObservations: {} }
  for (const key of ['total_market_cap_usd','total_volume_24h_usd','market_cap_change_24h_pct','btc_dominance_pct','eth_dominance_pct','stablecoin_market_cap_usd','defi_market_cap_usd']) {
    const row = data.find(value => value[key] != null && value[key] !== '' && Number.isFinite(Number(value[key])))
    result[key] = row ? Number(row[key]) : null
    result.fieldObservations[key] = row ? { asOf: row.as_of || null } : null
  }
  return result
}

// Leaderboard climbers/fallers — who moved up/down the market-cap rankings since
// ~`days` ago, from the cached market_ranking_snapshots rank history (authenticated
// RLS read; no edge/provider call). Both snapshots use one provider and exact IDs.
// The available comparison clocks remain visible when seven days are not retained.
export async function loadRankMovers(supabase, { days = 7, limit = 6 } = {}) {
  const read = async query => {
    const { data, error } = await query
    if (error) throw error
    if (!Array.isArray(data)) throw new Error('Invalid ranking history response')
    return data
  }
  const latest = await read(supabase.from('market_rankings_available')
    .select('provider, provider_id, normalized_symbol, symbol, name, rank, as_of, fetched_at, snapshot_bucket')
    .eq('rank_kind', 'market_cap').order('snapshot_bucket', { ascending: false }).order('provider', { ascending: false }).order('rank', { ascending: true }).limit(400))
  if (!latest.length) return null
  const latestBucket = latest[0].snapshot_bucket, latestAsOf = latest[0].fetched_at || latestBucket, provider = latest[0].provider
  if (!['coingecko','coinmarketcap'].includes(provider) || !Number.isFinite(Date.parse(latestAsOf))) throw new Error('Ranking source identity is unavailable')
  const current = latest.filter(r => r.snapshot_bucket === latestBucket && r.provider === provider && r.provider_id != null)
  if (!current.length) throw new Error('Ranking asset identity is unavailable')
  const priorIso = new Date(Date.parse(latestAsOf) - days * 86_400_000).toISOString()
  const history = () => supabase.from('market_rankings_available').select('snapshot_bucket, fetched_at').eq('rank_kind', 'market_cap').eq('provider', provider)
  let pick = await read(history().lte('snapshot_bucket', priorIso).order('snapshot_bucket', { ascending: false }).limit(1))
  if (!pick.length) pick = await read(history().lt('snapshot_bucket', latestBucket).order('snapshot_bucket', { ascending: true }).limit(1))
  if (!pick.length) return null
  const priorAsOf = pick[0].fetched_at || pick[0].snapshot_bucket
  const prior = await read(supabase.from('market_rankings_available').select('provider_id, rank')
    .eq('rank_kind', 'market_cap').eq('provider', provider).eq('snapshot_bucket', pick[0].snapshot_bucket)
    .in('provider_id', [...new Set(current.map(r => r.provider_id))]).limit(400))
  const priorById = new Map(prior.map(r => [r.provider_id, r.rank]))
  const movers = []
  for (const r of current) {
    const prev = priorById.get(r.provider_id)
    if (prev == null || prev === r.rank) continue
    movers.push({ sourceProvider: provider, providerId: r.provider_id, symbol: r.symbol || r.normalized_symbol, name: r.name, rank: r.rank, prevRank: prev, delta: prev - r.rank })
  }
  return {
    days, sourceProvider: provider, asOf: latestAsOf, priorAsOf,
    climbers: movers.filter(m => m.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit),
    fallers: movers.filter(m => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit),
  }
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

// Degen momentum trajectory — reads a memecoin's snapshot history (price /
// momentum_score / volume over the last `hours`) from memecoin_token_snapshots
// (authenticated RLS read; the entire history was written but never read by the
// client). Returns a compact series + deltas, or null with < 2 points.
export async function loadDegenMomentum(supabase, chain, address, { hours = 24, points = 24 } = {}) {
  if (!chain || !address) return null
  try {
    const since = new Date(Date.now() - hours * 3600_000).toISOString()
    const { data } = await supabase.from('memecoin_token_snapshots')
      .select('price_usd, momentum_score, volume_24h_usd, as_of')
      .eq('chain', chain).eq('token_address', address)
      .gte('as_of', since).order('as_of', { ascending: true }).limit(200)
    if (!data || data.length < 2) return null
    const series = data.slice(-points)
    const first = series[0], last = series[series.length - 1]
    const fp = Number(first.price_usd), lp = Number(last.price_usd)
    const priceChangePct = (Number.isFinite(fp) && fp > 0 && Number.isFinite(lp)) ? ((lp - fp) / fp) * 100 : null
    const fm = first.momentum_score, lm = last.momentum_score
    return {
      hours, points: series.length,
      priceSeries: series.map((r) => Number(r.price_usd)),
      priceChangePct,
      latestMomentum: lm != null ? Number(lm) : null,
      momoDelta: (fm != null && lm != null) ? Number(lm) - Number(fm) : null,
      volChangePct: (first.volume_24h_usd > 0 && last.volume_24h_usd != null) ? ((Number(last.volume_24h_usd) - Number(first.volume_24h_usd)) / Number(first.volume_24h_usd)) * 100 : null,
    }
  } catch { return null }
}

// Resolve an EVM contract address to the chain(s) it trades on (DexScreener
// multichain search, restricted to enrichable chains). Returns candidates sorted
// by liquidity desc: [{ chain, symbol, liquidityUsd, fdv }]. [] on miss/error so
// the caller degrades to a not-found message. EVM-only — Solana mints are
// unambiguous and skip this.
export async function locateToken(supabase, address) {
  if (!address) return []
  try {
    const { data, error } = await supabase.functions.invoke('intel-token-locate', { body: { address } })
    if (error || data?.error) return []
    return Array.isArray(data?.candidates) ? data.candidates : []
  } catch { return [] }
}

// Global cached token/project profile (M5). Flexible identifiers; returns the
// cached profile instantly and enqueues a background refresh when stale.
export async function loadTokenProfile(supabase, ident = {}, { orgId, refresh = false, signal } = {}) {
  const { data, error } = await supabase.functions.invoke('token-profile-get', { body: { ...ident, ...(orgId ? { orgId } : {}), refresh }, ...(signal ? { signal } : {}) })
  if (error || data?.error || !data || typeof data.state !== 'string') throw new Error('Project details could not be loaded.')
  return data
}

// Full single-asset detail (signal + WHY factors + per-provider reads + market
// cap + spread + rollups + RAG memory + on-demand candles) for ANY exchange
// symbol. Powers /intel/markets/:symbol.
export async function loadMarketDetail(supabase, orgId, symbol, identity = {}) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, symbol, ...identity } })
  if (error) { const details = await error.context?.json?.().catch(() => null); const failure = new Error(details?.error || error.message || 'market_detail_failed'); failure.code = details?.error; throw failure }
  if (data?.error) throw new Error(data.error)
  return data
}

// Lightweight per-timeframe candles for chart cycling (1H…1Y). The backend
// returns candles already scoped to the requested range (real intraday for short
// ranges via CEX klines). candlesOnly skips the full detail assembly.
export async function loadMarketCandles(supabase, orgId, symbol, timeframe = '7D', identity = {}) {
  return (await loadMarketCandleSnapshot(supabase, orgId, symbol, timeframe, identity)).candles
}

export async function loadMarketCandleSnapshot(supabase, orgId, symbol, timeframe = '7D', identity = {}) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, symbol, timeframe, candlesOnly: true, ...identity } })
  if (error) throw new Error(error.message || 'candles_failed')
  if (data?.error) throw new Error(data.error)
  return {...data,candles:data?.candles||[],capture:data?.captureProof?{proof:data.captureProof,bars:data.candles}:null,coverage:data?.coverage||null,state:data?.sourceState||null,provenance:data?.provenance||null}
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
