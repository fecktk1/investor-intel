// Investor Intel — Markets page read API (canonical Top-N + enrichment).
//
// LIST mode: the canonical universe is `market_assets` (top-N by market cap from
// a swappable provider). CEX data (Binance/Coinbase/Kraken/KuCoin) and DEX data
// (DexScreener/GeckoTerminal via memecoin_latest_tokens) are LEFT-JOINed as
// ENRICHMENT only — a token never drops for missing CEX/DEX. CEX matching is
// confidence-gated (cex-match.ts); spread/arbitrage render ONLY at high
// confidence. Reads cached tables only — never a live provider call.
//
// DETAIL mode (?symbol): full single-asset CEX breakdown (+ on-demand candles),
// unchanged from the exchange-market layer.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { getProvider } from '../_shared/exchange-market/provider-registry.ts'
import { buildSymbolCounts, matchCexEnrichment } from '../_shared/market-assets/cex-match.ts'
import { computeRowFlags, categoryLeaders } from '../_shared/intel/market-derived.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

const FRESH_MS = 5 * 60_000, STALE_MS = 60 * 60_000
function freshness(asOf: string | null, providerDegraded: boolean): 'fresh' | 'stale' | 'degraded' | 'unavailable' {
  if (!asOf) return 'unavailable'
  const age = Date.now() - new Date(asOf).getTime()
  if (providerDegraded) return 'degraded'
  if (age <= FRESH_MS) return 'fresh'
  if (age <= STALE_MS) return 'stale'
  return 'degraded'
}
const n = (v: unknown) => (typeof v === 'number' ? v : -Infinity)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'unauthorized' }, 401)
    const u = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authHeader } } })
    const { data: { user } } = await u.auth.getUser()
    if (!user) return json({ error: 'unauthorized' }, 401)
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    const body = await req.json().catch(() => ({})) as Record<string, unknown>

    if (typeof body.symbol === 'string' && body.symbol.trim()) {
      return await marketDetail(admin, body.symbol.toUpperCase().replace(/^\$/, ''))
    }

    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    const page = Math.max(0, Number(body.page) || 0)
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
    const sort = String(body.sort || 'market_cap')
    const search = String(body.search || '').trim().toLowerCase()
    const chain = body.chain ? String(body.chain).toLowerCase() : null
    const category = body.category ? String(body.category) : null
    const signalDirection = body.signalDirection ? String(body.signalDirection) : null
    const marketCapAvailability = body.marketCapAvailability ? String(body.marketCapAvailability) : null
    const exchangeAvailability = body.exchangeAvailability ? String(body.exchangeAvailability) : null // 'available' | 'none'
    const watchlistOnly = !!body.watchlistOnly
    const view = body.view ? String(body.view) : null // unusual_volume|vol_up_price_flat|price_up_liq_weak|multi_exchange|thin_liquidity

    // ── Read canonical base + all enrichment sources (cache-only) ──
    const [assetsR, profilesR, tickersR, sigsR, spreadsR, mapsR, chainsR, provR] = await Promise.all([
      admin.from('market_assets').select('*').order('market_cap_rank', { ascending: true, nullsFirst: false }).limit(2000),
      admin.from('exchange_latest_asset_profiles').select('*').limit(2000),
      admin.from('exchange_latest_tickers').select('provider, normalized_symbol, price, price_change_pct_24h, volume_quote_24h, bid_price, ask_price, spread_pct').limit(8000),
      admin.from('exchange_latest_market_signals').select('*').limit(2000),
      admin.from('exchange_latest_cross_market_spreads').select('*').order('estimated_net_spread_pct', { ascending: false }).limit(200),
      admin.from('exchange_asset_mappings').select('normalized_symbol, canonical_asset_id, contract_address, mapping_source, is_active').eq('is_active', true).limit(2000),
      admin.from('exchange_latest_chain_rollups').select('*').limit(100),
      admin.from('exchange_market_providers').select('provider, last_ok_at, last_error_at, banned_until, rate_limited_until, consecutive_failures'),
    ])

    const assets = assetsR.data || []
    const profileBySym = new Map<string, Record<string, unknown>>((profilesR.data || []).map((p) => [p.normalized_symbol, p]))
    const sigBySym = new Map<string, Record<string, unknown>>((sigsR.data || []).map((s) => [s.normalized_symbol, s]))
    const spreadBySym = new Map<string, Record<string, unknown>>((spreadsR.data || []).map((s) => [s.normalized_symbol, s]))
    const mappingBySym = new Map<string, Record<string, unknown>>((mapsR.data || []).map((m) => [String(m.normalized_symbol).toUpperCase(), m]))
    // group per-provider tickers by normalized symbol
    const tickersBySym = new Map<string, Record<string, unknown>[]>()
    for (const t of (tickersR.data || [])) { const k = t.normalized_symbol; (tickersBySym.get(k) || tickersBySym.set(k, []).get(k)!).push(t) }

    // optional DEX enrichment (memecoin_latest_tokens by chain:contract) — table may not exist yet
    const dexByContract = new Map<string, Record<string, unknown>>()
    try {
      const { data: dex } = await admin.from('memecoin_latest_tokens').select('chain, token_address, liquidity_usd, volume_24h_usd, image_url').limit(5000)
      for (const d of (dex || [])) dexByContract.set(`${d.chain}:${String(d.token_address).toLowerCase()}`, d)
    } catch { /* pre-migration */ }

    // provider status / degraded
    const providerStatus = (provR.data || []).map((p) => {
      const banned = p.banned_until && new Date(p.banned_until).getTime() > Date.now()
      const limited = p.rate_limited_until && new Date(p.rate_limited_until).getTime() > Date.now()
      const degraded = banned || limited || (p.consecutive_failures || 0) >= 3
      return { provider: p.provider, degraded: !!degraded, last_ok_at: p.last_ok_at }
    })
    const anyProviderDegraded = providerStatus.some((p) => p.degraded)

    // watchlist symbols — loaded whenever an org is known (powers the
    // watchlistMovers panel; the watchlistOnly toggle still gates filtering).
    let watchSet: Set<string> | null = null
    if (orgId) {
      const { data: wl } = await admin.from('watchlist_items').select('entity:entities(display_symbol)').eq('org_id', orgId)
      watchSet = new Set((wl || []).map((w) => String((w.entity as { display_symbol?: string })?.display_symbol || '').toUpperCase().replace(/^\$/, '')).filter(Boolean))
    }

    const symbolCounts = buildSymbolCounts(assets.map((a) => ({ normalizedSymbol: a.normalized_symbol })))

    // ── build canonical rows + enrichment ──
    const rows = assets.map((a) => {
      const platforms = (a.platforms && typeof a.platforms === 'object') ? a.platforms as Record<string, string> : null
      const match = matchCexEnrichment({ normalizedSymbol: a.normalized_symbol, providerId: a.provider_id, platforms }, { profileBySym, mappingBySym, symbolCounts })
      const conf = match.confidence
      const profile = match.profile
      const sym = a.normalized_symbol as string | null

      // CEX per-provider rollup (only when matched with >= medium confidence)
      let cex: Record<string, unknown> | null = null
      if (profile && (conf === 'high' || conf === 'medium')) {
        const tks = (sym && tickersBySym.get(sym)) || []
        const prices = tks.map((t) => Number(t.price)).filter((x) => Number.isFinite(x) && x > 0)
        const providers = [...new Set(tks.map((t) => String(t.provider)))]
        const sig = sym ? sigBySym.get(sym) : null
        const spread = (conf === 'high' && sym) ? spreadBySym.get(sym) : null
        cex = {
          availableCount: providers.length || (Array.isArray(profile.providers) ? (profile.providers as unknown[]).length : 0),
          providers: providers.length ? providers : (Array.isArray(profile.providers) ? profile.providers : []),
          bestPrice: prices.length ? Math.min(...prices) : (profile.latest_price ?? null),
          avgPrice: prices.length ? prices.reduce((s, x) => s + x, 0) / prices.length : (profile.latest_price ?? null),
          volume24h: tks.reduce((s, t) => s + (Number(t.volume_quote_24h) || 0), 0) || profile.latest_volume_quote_24h || null,
          spreadPct: spread ? spread.estimated_net_spread_pct ?? null : null,
          arbPct: spread ? spread.estimated_net_spread_pct ?? null : null,
          arbBuy: spread ? spread.buy_provider ?? null : null,
          arbSell: spread ? spread.sell_provider ?? null : null,
          signalDirection: profile.signal_direction ?? null,
          signalStrength: profile.signal_strength ?? null,
          signalConfidence: profile.signal_confidence ?? null,
          marketContext: sig ? { direction: sig.direction, strength: sig.strength, confidence: sig.confidence, title: sig.title, summary: sig.summary, whyItMatters: sig.why_it_matters, providerCount: sig.provider_count, confirmingProviders: sig.confirming_providers, factors: sig.factors, source: 'exchange-market' } : null,
        }
      }

      // DEX enrichment (by canonical contract)
      let dex: Record<string, unknown> | null = null
      if (platforms) {
        for (const [pchain, addr] of Object.entries(platforms)) {
          const d = dexByContract.get(`${pchain}:${String(addr).toLowerCase()}`)
          if (d) { dex = { liquidityUsd: d.liquidity_usd ?? null, volume24hUsd: d.volume_24h_usd ?? null, chain: pchain }; break }
        }
      }

      const availableCount = cex ? Number(cex.availableCount) || 0 : 0
      const detailHref = availableCount > 0
        ? `/intel/markets/${encodeURIComponent(a.symbol)}`
        : (a.primary_chain && platforms && platforms[a.primary_chain])
          ? `/intel/asset/${encodeURIComponent(`${a.primary_chain}:${platforms[a.primary_chain]}`)}`
          : `/intel/markets/${encodeURIComponent(a.symbol)}`

      return {
        // identity
        sourceProvider: a.source_provider, providerId: a.provider_id, symbol: a.symbol, displayName: a.name,
        normalizedSymbol: a.normalized_symbol, chain: a.primary_chain, contract: a.primary_chain && platforms ? platforms[a.primary_chain] || null : null,
        rank: a.market_cap_rank, imageUrl: a.image_url, imageFallbackType: a.image_fallback_type,
        // market (canonical authoritative)
        price: a.current_price, change1hPct: a.change_1h_pct, change24hPct: a.change_24h_pct, change7dPct: a.change_7d_pct,
        volumeQuote24h: a.volume_24h, marketCap: a.market_cap, marketCapIsEstimated: false, fdv: a.fdv,
        circulatingSupply: a.circulating_supply, totalSupply: a.total_supply, maxSupply: a.max_supply,
        categories: a.categories || [], platforms: platforms || {},
        // enrichment
        cex, dex, enrichmentConfidence: conf,
        // backward-compatible fields for MarketsTable / movers
        signalDirection: cex ? ((cex.signalDirection as string | null) ?? null) : null,
        providers: cex ? cex.providers : [],
        confirmingProviders: cex && cex.marketContext ? (cex.marketContext as Record<string, unknown>).confirmingProviders || [] : [],
        marketContext: cex ? cex.marketContext : null,
        // attribution
        sourceLabel: a.source_label, sourceUrl: a.source_url, attributionLabel: a.attribution_label, lastRefreshedAt: a.last_refreshed_at,
        detailHref, asOf: a.as_of, freshness: freshness(a.as_of, anyProviderDegraded),
        // derived views — precomputed baseline math (mig 220) + cheap per-row flags
        derived: (a as Record<string, unknown>).derived || {},
        flags: null as unknown as ReturnType<typeof computeRowFlags>,
      }
    })
    for (const r of rows) r.flags = computeRowFlags(r)

    // ── filters ──
    let filtered = rows
    if (search) filtered = filtered.filter((r) =>
      r.symbol.toLowerCase().includes(search) ||
      (r.displayName || '').toLowerCase().includes(search) ||
      (r.contract && String(r.contract).toLowerCase() === search) ||
      Object.values(r.platforms || {}).some((addr) => String(addr).toLowerCase() === search))
    if (chain) filtered = filtered.filter((r) => (r.chain || '').toLowerCase() === chain || Object.keys(r.platforms || {}).some((c) => c.toLowerCase() === chain))
    if (category) filtered = filtered.filter((r) => Array.isArray(r.categories) && r.categories.includes(category))
    if (signalDirection) filtered = filtered.filter((r) => r.signalDirection === signalDirection)
    if (watchlistOnly && watchSet) filtered = filtered.filter((r) => watchSet!.has(String(r.normalizedSymbol || '').toUpperCase()))
    // Derived views — deterministic, fewer-better-clearer: each view narrows to
    // rows where the flag actually fired (caution flags always travel with rows).
    if (view === 'unusual_volume') filtered = filtered.filter((r) => r.flags.unusualVolume)
    else if (view === 'vol_up_price_flat') filtered = filtered.filter((r) => r.flags.volUpPriceFlat)
    else if (view === 'price_up_liq_weak') filtered = filtered.filter((r) => r.flags.priceUpLiquidityWeak)
    else if (view === 'multi_exchange') filtered = filtered.filter((r) => r.flags.multiExchangeStrength)
    else if (view === 'thin_liquidity') filtered = filtered.filter((r) => r.flags.thinLiquidity)
    if (marketCapAvailability === 'available') filtered = filtered.filter((r) => r.marketCap != null)
    else if (marketCapAvailability === 'unavailable') filtered = filtered.filter((r) => r.marketCap == null)
    if (exchangeAvailability === 'available') filtered = filtered.filter((r) => r.cex && Number((r.cex as Record<string, unknown>).availableCount) > 0)
    else if (exchangeAvailability === 'none') filtered = filtered.filter((r) => !r.cex || !Number((r.cex as Record<string, unknown>).availableCount))

    // ── sorts ──
    const arb = (r: typeof rows[number]) => (r.enrichmentConfidence === 'high' && r.cex && (r.cex as Record<string, unknown>).arbPct != null) ? Number((r.cex as Record<string, unknown>).arbPct) : -Infinity
    const avail = (r: typeof rows[number]) => r.cex ? Number((r.cex as Record<string, unknown>).availableCount) || 0 : 0
    const sorters: Record<string, (a: typeof rows[number], b: typeof rows[number]) => number> = {
      market_cap: (a, b) => n(b.marketCap) - n(a.marketCap),
      volume: (a, b) => n(b.volumeQuote24h) - n(a.volumeQuote24h),
      gainers: (a, b) => n(b.change24hPct) - n(a.change24hPct),
      losers: (a, b) => n(a.change24hPct) - n(b.change24hPct),
      change_1h: (a, b) => n(b.change1hPct) - n(a.change1hPct),
      change_24h: (a, b) => n(b.change24hPct) - n(a.change24hPct),
      change_7d: (a, b) => n(b.change7dPct) - n(a.change7dPct),
      exchange_availability: (a, b) => avail(b) - avail(a) || n(b.marketCap) - n(a.marketCap),
      arbitrage: (a, b) => arb(b) - arb(a) || n(b.marketCap) - n(a.marketCap),
      recently_updated: (a, b) => String(b.lastRefreshedAt || '').localeCompare(String(a.lastRefreshedAt || '')),
      unusual_volume: (a, b) => n(b.flags?.volumeRatio) - n(a.flags?.volumeRatio) || n(b.volumeQuote24h) - n(a.volumeQuote24h),
      multi_exchange_strength: (a, b) => avail(b) - avail(a) || n(b.change24hPct) - n(a.change24hPct),
    }
    filtered = filtered.slice().sort(sorters[sort] || sorters.market_cap)

    const total = filtered.length
    const pageRows = filtered.slice(page * limit, page * limit + limit)

    // ── snapshot (over ALL canonical) ──
    const withCap = rows.filter((r) => r.marketCap != null)
    const withCex = rows.filter((r) => r.cex && Number((r.cex as Record<string, unknown>).availableCount) > 0)
    const sigCounts = { bullish: 0, bearish: 0, caution: 0, neutral: 0 } as Record<string, number>
    for (const r of rows) if (r.signalDirection) sigCounts[r.signalDirection] = (sigCounts[r.signalDirection] || 0) + 1
    const strongestChain = (chainsR.data || []).slice().sort((a, b) => (b.avg_change_24h_pct ?? -999) - (a.avg_change_24h_pct ?? -999))[0]?.chain || null
    const lastUpdated = rows.reduce((m, r) => r.asOf && r.asOf > m ? r.asOf : m, '')
    const snapshot = {
      trackedAssets: rows.length,
      up24h: rows.filter((r) => (r.change24hPct ?? 0) > 0).length,
      down24h: rows.filter((r) => (r.change24hPct ?? 0) < 0).length,
      trackedVolumeQuote24h: rows.reduce((s, r) => s + (r.volumeQuote24h || 0), 0),
      trackedMarketCap: withCap.reduce((s, r) => s + (r.marketCap || 0), 0),
      marketCapCoveragePct: rows.length ? Math.round((withCap.length / rows.length) * 100) : 0,
      cexCoveragePct: rows.length ? Math.round((withCex.length / rows.length) * 100) : 0,
      strongestChain, signalCounts: sigCounts,
      lastUpdated: lastUpdated || null, freshness: freshness(lastUpdated || null, anyProviderDegraded),
    }

    // movers: blend 24h magnitude with market cap (so thin pumps rank lower)
    const moverScore = (r: typeof rows[number]) => Math.min(Math.abs(r.change24hPct ?? 0) / 25, 1) * 0.6 + Math.min((Math.log10(Math.max(1, r.marketCap ?? 1))) / 12, 1) * 0.4
    const movers = rows.filter((r) => (r.change24hPct ?? 0) !== 0)
    const topGainers = movers.filter((r) => (r.change24hPct ?? 0) > 0).sort((a, b) => moverScore(b) - moverScore(a)).slice(0, 10)
    const topLosers = movers.filter((r) => (r.change24hPct ?? 0) < 0).sort((a, b) => moverScore(b) - moverScore(a)).slice(0, 10)

    const capRows = rows.filter((r) => r.marketCap != null).sort((a, b) => n(b.marketCap) - n(a.marketCap))
    const marketCapPanel = { topByMarketCap: capRows.slice(0, 20), unavailableCount: rows.filter((r) => r.marketCap == null).length, estimatedCount: 0, coveragePct: snapshot.marketCapCoveragePct }

    const availableCategories = [...new Set(rows.flatMap((r) => Array.isArray(r.categories) ? r.categories as string[] : []))].sort()

    // Derived sections (computed over ALL canonical rows; capped, quality-gated).
    const watchlistMovers = watchSet && watchSet.size
      ? rows.filter((r) => watchSet!.has(String(r.normalizedSymbol || '').toUpperCase()) && typeof r.change24hPct === 'number')
        .sort((a, b) => Math.abs(b.change24hPct!) - Math.abs(a.change24hPct!)).slice(0, 10)
      : []
    const derivedCounts = {
      unusual_volume: rows.filter((r) => r.flags.unusualVolume).length,
      vol_up_price_flat: rows.filter((r) => r.flags.volUpPriceFlat).length,
      price_up_liq_weak: rows.filter((r) => r.flags.priceUpLiquidityWeak).length,
      multi_exchange: rows.filter((r) => r.flags.multiExchangeStrength).length,
      thin_liquidity: rows.filter((r) => r.flags.thinLiquidity).length,
    }

    return json({
      snapshot, rows: pageRows, total, page, limit,
      marketCapPanel, topGainers, topLosers, availableCategories,
      categoryLeaders: categoryLeaders(rows), watchlistMovers, derivedCounts,
      chainHeatmap: chainsR.data || [], crossExchangeSpreads: spreadsR.data || [],
      providerStatus, lastUpdated: snapshot.lastUpdated,
    })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'intel_markets_failed' }, 500)
  }
})

// ─── DETAIL mode (CEX breakdown + on-demand candles) — unchanged behavior ─────
// deno-lint-ignore no-explicit-any
async function fetchCandles(admin: any, sym: string): Promise<{ candles: { t: number; c: number }[]; bestPair: string | null; bestProvider: string | null }> {
  try {
    const { data: tk } = await admin.from('exchange_latest_tickers').select('provider, provider_symbol, volume_quote_24h').eq('normalized_symbol', sym).order('volume_quote_24h', { ascending: false }).limit(1).maybeSingle()
    if (!tk) return { candles: [], bestPair: null, bestProvider: null }
    const prov = getProvider(tk.provider)
    if (!prov) return { candles: [], bestPair: tk.provider_symbol, bestProvider: tk.provider }
    const ctx = { supabase: admin, jobName: 'intel-markets-detail', kind: 'request' as const }
    let k = await prov.getKlines(tk.provider_symbol, '1h', 168, ctx)
    if (!k || !k.length) k = await prov.getKlines(tk.provider_symbol, '1d', 90, ctx)
    const candles = (k || []).map((x) => ({ t: x.openTime, c: x.close }))
    return { candles, bestPair: tk.provider_symbol, bestProvider: tk.provider }
  } catch { return { candles: [], bestPair: null, bestProvider: null } }
}

// deno-lint-ignore no-explicit-any
async function marketDetail(admin: any, sym: string): Promise<Response> {
  const [profR, sigR, capR, sprR, rollR, tickR, provSigR, memR, maR] = await Promise.all([
    admin.from('exchange_latest_asset_profiles').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_market_signals').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_market_caps').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_latest_cross_market_spreads').select('*').eq('normalized_symbol', sym).maybeSingle(),
    admin.from('exchange_market_rollups').select('*').eq('normalized_symbol', sym),
    admin.from('exchange_latest_tickers').select('*').eq('normalized_symbol', sym),
    admin.from('exchange_market_signals').select('provider, direction, strength, confidence, signal_type, factors, raw_metrics, as_of').eq('normalized_symbol', sym).eq('scope', 'provider').order('as_of', { ascending: false }).limit(24),
    admin.from('exchange_market_memory').select('summary, why_it_matters, memory_type, as_of').eq('normalized_symbol', sym).eq('is_active', true).order('as_of', { ascending: false }).limit(1),
    admin.from('market_assets').select('*').eq('normalized_symbol', sym).order('market_cap', { ascending: false }).limit(1).maybeSingle(),
  ])
  const canonical = maR.data
  if (!profR.data && !sigR.data && !(tickR.data || []).length && !canonical) return json({ error: 'asset_not_found', symbol: sym }, 404)

  // deno-lint-ignore no-explicit-any
  const provSig = new Map<string, any>()
  for (const s of (provSigR.data || [])) if (!provSig.has(s.provider)) provSig.set(s.provider, s)
  // deno-lint-ignore no-explicit-any
  const tickByProv = new Map<string, any>((tickR.data || []).map((t: any) => [t.provider, t]))
  const providers = [...new Set([...(tickR.data || []).map((t: any) => t.provider), ...provSig.keys()])].map((p) => {
    const t = tickByProv.get(p); const s = provSig.get(p)
    return { provider: p, providerSymbol: t?.provider_symbol ?? null, price: t?.price ?? null, change24h: t?.price_change_pct_24h ?? null, volume24h: t?.volume_quote_24h ?? null, spreadPct: t?.spread_pct ?? null, direction: s?.direction ?? null, strength: s?.strength ?? null, confidence: s?.confidence ?? null, factors: s?.factors || [] }
  }).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))

  // deno-lint-ignore no-explicit-any
  const rollups: Record<string, any> = {}
  for (const r of (rollR.data || [])) rollups[r.timeframe] = r
  const { candles, bestPair, bestProvider } = await fetchCandles(admin, sym)
  const prof = profR.data, sig = sigR.data

  return json({
    detail: true, symbol: sym, displayName: prof?.display_name ?? canonical?.name ?? null, chain: prof?.chain ?? canonical?.primary_chain ?? null,
    imageUrl: canonical?.image_url ?? null,
    // Canonical identity → lets the detail page load the rich CoinGecko profile.
    providerId: canonical?.provider_id ?? null, sourceProvider: canonical?.source_provider ?? null, primaryChain: canonical?.primary_chain ?? null,
    price: prof?.latest_price ?? canonical?.current_price ?? providers[0]?.price ?? null,
    change24h: prof?.latest_change_24h_pct ?? canonical?.change_24h_pct ?? providers[0]?.change24h ?? null,
    change7d: prof?.latest_change_7d_pct ?? canonical?.change_7d_pct ?? rollups['7d']?.price_change_pct ?? null,
    volume24h: prof?.latest_volume_quote_24h ?? canonical?.volume_24h ?? providers[0]?.volume24h ?? null,
    signal: sig ? { direction: sig.direction, strength: sig.strength, confidence: sig.confidence, signalType: sig.signal_type, title: sig.title, summary: sig.summary, whyItMatters: sig.why_it_matters, factors: sig.factors || [], confirmingProviders: sig.confirming_providers || [], conflictingProviders: sig.conflicting_providers || [], providerCount: sig.provider_count } : null,
    profile: prof ? { liquidityScore: prof.liquidity_score, retailRelevanceScore: prof.retail_relevance_score, marketQualityScore: prof.market_quality_score, trendScore: prof.trend_score, bestGlobalPair: prof.best_global_pair, bestUsRetailPair: prof.best_us_retail_pair } : null,
    marketCap: capR.data || (canonical ? { market_cap: canonical.market_cap, fdv: canonical.fdv, circulating_supply: canonical.circulating_supply, market_cap_source: canonical.source_provider } : null),
    spread: sprR.data || null, rollups, providers,
    memorySummary: memR.data?.[0]?.summary || null,
    candles, bestPair, bestProvider, asOf: prof?.as_of || sig?.as_of || canonical?.as_of || null,
  })
}
