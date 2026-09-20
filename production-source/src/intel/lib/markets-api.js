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

// Ranked catalogue suggestions for typed text — a ticker, a project name or a
// pasted contract. One bounded read of the shared market catalogue: no provider
// call, no credit, and the same free `market_boards` surface the screen uses, so
// a member who may see the screen may also search it.
export const SUGGEST_MIN_LENGTH = 2
/** The matches that name ONE asset rather than merely starting like it. */
export const SUGGEST_EXACT_MATCHES = ['contract', 'symbol_exact', 'name_exact']
export async function suggestMarketAssets(supabase, orgId, query, { limit = 8, signal } = {}) {
  const q = String(query ?? '').trim().slice(0, 100)
  if (!orgId || q.length < SUGGEST_MIN_LENGTH) return []
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, op: 'suggest', q, limit }, ...(signal ? { signal } : {}) })
  if (error) { const details = await error.context?.json?.().catch(() => null); const failure = new Error(details?.error || error.message || 'suggest_failed'); failure.code = details?.error; throw failure }
  if (data?.error) { const failure = new Error(data.error); failure.code = data.error; throw failure }
  return Array.isArray(data?.matches) ? data.matches : []
}

/**
 * Every match that names the asset outright rather than merely starting like it.
 *
 * This used to take the strongest bucket and stop, which meant a ticker match
 * hid a name match entirely: for "bitcoin" it returned two meme tokens called
 * BITCOIN and never mentioned Bitcoin. Sharing a ticker with the asset the
 * reader named is not better evidence than being it, so the whole tier is
 * returned, in the order the server ranked it (largest market cap first).
 */
export function exactSuggestMatches(matches = []) {
  return (matches || []).filter(row => SUGGEST_EXACT_MATCHES.includes(row?.match))
}

/**
 * What a typed `/intel/markets/<input>` address means.
 *
 * Exactly one asset in the exact tier IS the answer: it is opened, never offered
 * as a list of one. When the text really does name several assets the whole tier
 * is the choice, in the order the server ranked it, so "bitcoin" leads with
 * Bitcoin and still shows the tokens that share its ticker underneath.
 */
export function assetAddressTarget(matches = [], currentHref = '') {
  const exact = exactSuggestMatches(matches)
  const open = exact.length === 1 && exact[0].href && exact[0].href !== currentHref ? exact[0] : null
  if (open) return { open, candidates: [] }
  return { open: null, candidates: exact.length > 1 ? exact : (matches || []) }
}

/**
 * What a BARE `/intel/markets/<input>` address names, asked BEFORE anything is
 * read, because the symbol read cannot answer it.
 *
 * `/intel/markets/bitcoin` used to be read as the ticker BITCOIN, which a meme
 * token carries, so that read succeeded and the ranked answer never ran: the
 * page opened HarryPotterObamaSonic10Inu. Being ranked first for the text the
 * reader typed is the answer here, so the catalogue is asked first and the read
 * follows what it says.
 *
 * Returns `{ open, candidates }`:
 *   open        the one asset the exact tier names. Navigate to its href.
 *   candidates  the whole exact tier, in the server's order, when several are
 *               named (Bitcoin leads for "bitcoin", Solana for "SOL").
 *   both empty  nothing in the exact tier: the caller reads the address as a
 *               symbol exactly as before. `matches` is null when the catalogue
 *               could not be asked at all (error, lock, transport), which is the
 *               same fall-back and tells the caller it still has to ask later.
 */
export async function resolveAssetAddress(supabase, orgId, input, currentHref = '', { limit = 8, signal } = {}) {
  let matches = null
  try { matches = await suggestMarketAssets(supabase, orgId, input, { limit, signal }) }
  catch { return { open: null, candidates: [], matches: null } }
  const exact = exactSuggestMatches(matches)
  if (!exact.length) return { open: null, candidates: [], matches }
  const target = assetAddressTarget(matches, currentHref)
  // A lone exact match that IS the address already on screen is not a choice of
  // one: it falls through to the read, exactly as an empty tier does.
  return { open: target.open, candidates: target.open || exact.length < 2 ? [] : target.candidates, matches }
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
// (cache-only). Params: { page, limit, sort, dir, search, chain, bucket, riskMax,
// minLiquidity, showExcluded }. `dir` and `showExcluded` are passed through
// untouched: the server owns sort direction and the excluded-rows view, and an
// unknown `sort` is now a 400 (`invalid_sort`) rather than a silent re-order,
// so nothing here may substitute a default.
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

// Universal asset resolution. Takes ANY identifier a reader can paste — a
// contract address on any supported namespace, a CoinMarketCap id, a Hyperliquid
// pair — and asks the intel-asset-resolve ladder (catalogue → entities →
// memecoin → CMC metadata/DEX → DexScreener → GeckoTerminal → Birdeye → RPC)
// which asset it is. The ladder's provenance is part of the contract: every step
// reports hit/miss/skipped/error so a failure can always be explained.
//
// Never throws and never returns an empty object: a transport failure, a rate
// limit (HTTP 429) or a malformed response all degrade to an 'unresolved' result
// carrying a t-able reason code, so the caller renders a reason instead of a
// blank space.
export async function resolveAsset(supabase, query, chain = null, { orgId, signal } = {}) {
  const unresolved = reason => ({ status: 'unresolved', query: String(query ?? ''), detected: [], candidates: [], provenance: [], reason })
  // The function answers 400 for 'invalid' and 429 for 'rate_limited' and still
  // sends the whole result, so a non-2xx body is a resolution — not a transport
  // failure. Reading it is what keeps "this is not an identifier" distinct from
  // "the resolver did not answer". 'rate_limited' becomes an unresolved result
  // whose reason names the limit, so every caller handles five statuses.
  const normalize = payload => {
    if (!payload || typeof payload.status !== 'string') return null
    const base = { ...payload, query: payload.query ?? String(query ?? ''), detected: Array.isArray(payload.detected) ? payload.detected : [], candidates: Array.isArray(payload.candidates) ? payload.candidates : [], provenance: Array.isArray(payload.provenance) ? payload.provenance : [] }
    if (base.status === 'rate_limited') return { ...base, status: 'unresolved', reason: base.reason || 'rate_limited' }
    // 'identity_only' is a resolution, not a failure: the chain named the asset
    // and no market source answered. Dropping it into 'unresolved' would hide a
    // real, indexed, searchable asset behind "nothing answered".
    return ['resolved', 'identity_only', 'ambiguous', 'unresolved', 'invalid'].includes(base.status) ? base : { ...base, status: 'unresolved', reason: base.reason || 'resolver_unavailable' }
  }
  try {
    const { data, error } = await supabase.functions.invoke('intel-asset-resolve', {
      body: { query, ...(chain ? { chain } : {}), ...(orgId ? { orgId } : {}) },
      ...(signal ? { signal } : {}),
    })
    if (error) {
      const details = await error.context?.json?.().catch(() => null)
      return normalize(details) || unresolved(details?.error || error.message || 'resolver_unavailable')
    }
    if (data?.error) return unresolved(data.error)
    return normalize(data) || unresolved('resolver_unavailable')
  } catch { return unresolved('resolver_unavailable') }
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
/** The period the detail read's candles cover. The asset page seeds only this
 * period's chart cache with them; a restored wider period loads its own. */
export const DETAIL_CANDLE_RANGE = '7D'
export async function loadMarketDetail(supabase, orgId, symbol, identity = {}) {
  const { data, error } = await supabase.functions.invoke('intel-markets', { body: { orgId, symbol, timeframe: DETAIL_CANDLE_RANGE, ...identity } })
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

// ── Price history on demand, and the facts the daily passes already recorded ──

const HISTORY_UNAVAILABLE = reason => ({
  history: { points: [], interval: null, source: null, observedAt: null, fetchedAt: null, state: 'unavailable', reason, credits: null },
  metrics: { volatility30d: null, maxDrawdown: null, distanceFromHigh: null, timeUnderWaterDays: null },
  identity: null,
})

// Read one price-history window for an asset, plus the risk measures derived
// from exactly those points (intel-markets `history` mode).
//
// A history read is the one read a reader pays for: the provider is sampled once
// per range and the snapshot is then shared, so this is only ever called from an
// explicit request. Never throws: an invalid range (HTTP 400
// `invalid_history_range`), a rate limit, an exhausted budget or an unreachable
// function all come back as `history.state: 'unavailable'` carrying the server's
// own reason code, so the caller renders a reason rather than an empty chart.
// A contract identity answers `no_coinmarketcap_listing` with every metric null.
export async function readAssetHistory(supabase, { orgId, symbol, sourceProvider, providerId, range = '90d', signal } = {}) {
  const body = {
    orgId,
    history: true,
    range,
    ...(sourceProvider && providerId != null ? { sourceProvider, providerId: String(providerId) } : symbol ? { symbol } : {}),
  }
  try {
    const { data, error } = await supabase.functions.invoke('intel-markets', { body, ...(signal ? { signal } : {}) })
    if (error) {
      const details = await error.context?.json?.().catch(() => null)
      return HISTORY_UNAVAILABLE(details?.error || error.message || 'history_unavailable')
    }
    if (data?.error) return HISTORY_UNAVAILABLE(data.error)
    if (!data || typeof data !== 'object' || !data.history) return HISTORY_UNAVAILABLE('history_unavailable')
    const history = data.history
    return {
      history: {
        ...history,
        points: Array.isArray(history.points) ? history.points : [],
        state: typeof history.state === 'string' ? history.state : 'unavailable',
        reason: history.reason ?? (history.state === 'unavailable' ? 'history_unavailable' : null),
      },
      metrics: data.metrics && typeof data.metrics === 'object' ? data.metrics : HISTORY_UNAVAILABLE('history_unavailable').metrics,
      identity: data.identity || null,
    }
  } catch { return HISTORY_UNAVAILABLE('history_unavailable') }
}

const FACTS_UNAVAILABLE = (op, reason) => (op === 'cohorts'
  ? { state: 'unavailable', reason, cohorts: [], assets: null, unavailable: true }
  : {
    state: 'unavailable', reason,
    asset: null, supply: null, age: null, deployments: [], notice: null,
    deltas: { rows: [], days: null, unavailable: true, reason }, factsAt: null, attribution: null,
  })

// Read the recorded facts for one asset — supply trust, the listing notice, every
// deployment, listing age and the daily market-pair/supply deltas — or the
// listing-age cohort table (`op: 'cohorts'`). Both are reads of rows another job
// already wrote: no provider call, no credits.
//
// Never throws. A 404 (`asset_not_found`), a 400 or an unreachable function all
// come back as `{ state: 'unavailable', reason }` with every section empty, so
// no section can ever be filled in with a number that was not read.
export async function readAssetFacts(supabase, { orgId, sourceProvider, providerId, days = 30, op = 'asset', provider, signal } = {}) {
  const body = op === 'cohorts'
    ? { op: 'cohorts', orgId, ...(provider ? { provider } : {}) }
    : { op: 'asset', orgId, sourceProvider, providerId: providerId == null ? providerId : String(providerId), days }
  try {
    const { data, error } = await supabase.functions.invoke('intel-asset-facts', { body, ...(signal ? { signal } : {}) })
    if (error) {
      const details = await error.context?.json?.().catch(() => null)
      return FACTS_UNAVAILABLE(op, details?.error || error.message || 'asset_facts_unavailable')
    }
    if (data?.error) return FACTS_UNAVAILABLE(op, data.error)
    if (!data || typeof data !== 'object') return FACTS_UNAVAILABLE(op, 'asset_facts_unavailable')
    if (op === 'cohorts') {
      if (!Array.isArray(data.cohorts)) return FACTS_UNAVAILABLE(op, data.reason || 'asset_facts_unavailable')
      return { ...data, state: data.unavailable ? 'unavailable' : 'ready', reason: data.reason ?? null }
    }
    if (!data.asset) return FACTS_UNAVAILABLE(op, data.reason || 'asset_facts_unavailable')
    return {
      ...data,
      state: 'ready',
      reason: null,
      deployments: Array.isArray(data.deployments) ? data.deployments : [],
      deltas: data.deltas && typeof data.deltas === 'object'
        ? { ...data.deltas, rows: Array.isArray(data.deltas.rows) ? data.deltas.rows : [] }
        : { rows: [], days: null, unavailable: true, reason: 'asset_facts_unavailable' },
    }
  } catch { return FACTS_UNAVAILABLE(op, 'asset_facts_unavailable') }
}

// ── Contract identity resolution for portfolio holdings (proposal 25) ────────

const IDENTITY_UNAVAILABLE = (op, reason, extra = {}) => ({
  // A 429 body carries retryAfterSeconds / limit / windowSeconds / runsInWindow.
  // They are kept verbatim so the surface can say WHEN, not just "try later".
  ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
  op,
  state: 'unavailable',
  reason,
  chains: [],
  totals: null,
  holdings: [],
  holdingIds: [],
  entities: [],
  unsupported: [],
})

/** Holdings one `unprice` call may reset (`UNPRICE_MAX` in the function). A
 *  longer list is a 400, so the caller must cut it and say so, never send it. */
export const UNPRICE_MAX = 50

// Read (or run) contract identity resolution for the org's open holdings —
// `intel-portfolio-identity`, three operations:
//
//   coverage  priced-versus-unpriced by chain. Rows only: no provider call and
//             no credits. Every chain in the book reports real counts, zeros
//             included, and an unsupported chain carries the reason it is one.
//   resolve   asks CoinMarketCap's DEX batch endpoints about the open
//             unpriced/stale holdings on a verified chain and writes the prices
//             it is given. SPENDS PROVIDER CREDITS, and four runs an hour per
//             organisation is the ceiling.
//   entities  fills entities.provider_ids.coinmarketcap. One credit per entity.
//   unprice   undoes THIS feature's own writes for named holdings (≤50 ids).
//             Spends nothing and is never rate limited: an undo has to stay
//             available, or a member who spent their four runs producing a bad
//             price would be stuck with it for an hour. Only rows still sourced
//             `coinmarketcap_dex` are reset; the rest come back as `skipped`.
//
// Mirrors `readAssetFacts`: never throws. A 429 (`resolution_rate_limited`), a
// 503, a 400 or an unreachable function all come back as
// `{ state: 'unavailable', reason }` with the body's own fields intact, so the
// caller renders what happened rather than an empty panel.
export async function readPortfolioIdentity(supabase, { orgId, op = 'coverage', portfolioId, limit, holdingIds, signal } = {}) {
  const operation = ['coverage', 'resolve', 'entities', 'unprice'].includes(op) ? op : 'coverage'
  const ids = Array.isArray(holdingIds) ? [...new Set(holdingIds.map(id => String(id)))] : null
  const body = {
    op: operation,
    orgId,
    ...(portfolioId ? { portfolioId: String(portfolioId) } : {}),
    ...(limit == null ? {} : { limit }),
    // The function refuses a longer list outright, so the cut is made here and
    // the caller is told how many were sent rather than the whole call failing.
    ...(operation === 'unprice' && ids?.length ? { holdingIds: ids.slice(0, UNPRICE_MAX) } : {}),
  }
  try {
    const { data, error } = await supabase.functions.invoke('intel-portfolio-identity', { body, ...(signal ? { signal } : {}) })
    if (error) {
      const details = await error.context?.json?.().catch(() => null)
      return IDENTITY_UNAVAILABLE(operation, details?.error || error.message || 'portfolio_identity_unavailable', details)
    }
    if (data?.error) return IDENTITY_UNAVAILABLE(operation, data.error, data)
    if (!data || typeof data !== 'object') return IDENTITY_UNAVAILABLE(operation, 'portfolio_identity_unavailable')
    return {
      ...data,
      op: typeof data.op === 'string' ? data.op : operation,
      state: 'ready',
      reason: null,
      // Every list is a list. A missing one is an empty read, never a crash in
      // the render that maps over it.
      chains: Array.isArray(data.chains) ? data.chains : [],
      holdings: Array.isArray(data.holdings) ? data.holdings : [],
      // `unprice` answers with the ids it actually reset, which is what tells a
      // reset apart from a skip.
      holdingIds: Array.isArray(data.holdingIds) ? data.holdingIds.map(id => String(id)) : [],
      entities: Array.isArray(data.entities) ? data.entities : [],
      unsupported: Array.isArray(data.unsupported) ? data.unsupported : [],
      totals: data.totals && typeof data.totals === 'object' ? data.totals : null,
    }
  } catch { return IDENTITY_UNAVAILABLE(operation, 'portfolio_identity_unavailable') }
}

// Long-memory "year in review" for an asset (migration 228). Deterministic
// rollup series + major events + top narratives over the last ~15 months.
export async function loadAssetYearInReview(supabase, symbol, months = 15) {
  const { data, error } = await supabase.rpc('intel_asset_year_in_review', { p_symbol: String(symbol || '').toUpperCase().replace(/^\$/, ''), p_months: months })
  if (error) throw error
  return data
}
