// Investor Intel — Degen (memecoin) read API. Reads memecoin_latest_tokens ONLY
// (cache-only; never a live provider call). Quality-gated buckets (G4): Hot/
// Trending/Established/High-Liquidity/High-Volume require verified market data;
// pre-liquidity launches surface ONLY in New Launches / Pump.fun (G3). Every row
// carries discovery_reasons + source; rows without them are never returned.

import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }
const n = (v: unknown) => (typeof v === 'number' ? v : -Infinity)

const HOT_MIN_VOL = 50_000, HOT_MIN_LIQ = 20_000
const ESTABLISHED_AGE_MS = 30 * 24 * 3600_000, ESTABLISHED_MIN_LIQ = 100_000, ESTABLISHED_MIN_VOL = 100_000
const HIGH_VOL = 1_000_000, HIGH_LIQ = 250_000

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
    const orgId = typeof body.orgId === 'string' ? body.orgId : null
    const page = Math.max(0, Number(body.page) || 0)
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 50))
    const sort = String(body.sort || 'trending')
    const search = String(body.search || '').trim().toLowerCase()
    const chain = body.chain ? String(body.chain).toLowerCase() : null
    const bucket = body.bucket ? String(body.bucket) : null
    const riskMax = body.riskMax != null ? Number(body.riskMax) : null
    const minLiquidity = body.minLiquidity != null ? Number(body.minLiquidity) : null

    let tokensR
    try { tokensR = await admin.from('memecoin_latest_tokens').select('*').order('volume_24h_usd', { ascending: false, nullsFirst: false }).limit(2000) }
    catch { return json({ snapshot: emptySnap(), rows: [], total: 0, page, limit }) }
    const all = (tokensR?.data || []).filter((r: Record<string, unknown>) => Array.isArray(r.discovery_reasons) && (r.discovery_reasons as unknown[]).length > 0 && r.source)

    // watchlist set (degen tokens by chain:contract)
    let watchSet: Set<string> | null = null
    if (bucket === 'watchlist' && orgId) {
      const { data: wl } = await admin.from('watchlist_items').select('entity:entities(chain, contract_address)').eq('org_id', orgId)
      watchSet = new Set((wl || []).map((w) => { const e = (w.entity as { chain?: string; contract_address?: string }); return e?.chain && e?.contract_address ? `${String(e.chain).toLowerCase()}:${String(e.contract_address).toLowerCase()}` : null }).filter(Boolean) as string[])
    }

    const now = Date.now()
    const ageMs = (r: Record<string, unknown>) => r.pair_created_at ? now - new Date(r.pair_created_at as string).getTime() : null
    const verified = (r: Record<string, unknown>) => r.listing_state === 'verified' && r.liquidity_verified === true

    // bucket gates (G3/G4)
    const passBucket = (r: Record<string, unknown>): boolean => {
      const vol = Number(r.volume_24h_usd) || 0, liq = Number(r.liquidity_usd) || 0, risk = Number(r.risk_score) || 0
      switch (bucket) {
        case 'hot': return verified(r) && vol >= HOT_MIN_VOL && liq >= HOT_MIN_LIQ
        case 'trending': return verified(r) && (r.is_trending === true || r.is_boosted === true) && vol >= HOT_MIN_VOL
        case 'new': { const a = ageMs(r); return r.is_new === true || r.listing_state === 'pre_liquidity' || (a != null && a < 48 * 3600_000) }
        case 'pumpfun': return r.is_pumpfun === true
        case 'migrated': return r.is_migrated === true
        case 'takeovers': return r.is_takeover === true
        case 'established': { const a = ageMs(r); return verified(r) && a != null && a >= ESTABLISHED_AGE_MS && liq >= ESTABLISHED_MIN_LIQ && vol >= ESTABLISHED_MIN_VOL }
        case 'high_volume': return verified(r) && vol >= HIGH_VOL
        case 'high_liquidity': return verified(r) && liq >= HIGH_LIQ
        case 'high_risk': return risk >= 60
        case 'watchlist': return !!watchSet && watchSet.has(`${String(r.chain).toLowerCase()}:${String(r.token_address).toLowerCase()}`)
        default: return verified(r) // default view: verified only (no pre-liquidity flood)
      }
    }

    let filtered = all.filter(passBucket)
    if (search) filtered = filtered.filter((r) => String(r.symbol || '').toLowerCase().includes(search) || String(r.name || '').toLowerCase().includes(search) || String(r.token_address || '').toLowerCase() === search)
    if (chain) filtered = filtered.filter((r) => String(r.chain).toLowerCase() === chain)
    if (riskMax != null) filtered = filtered.filter((r) => (Number(r.risk_score) || 0) <= riskMax)
    if (minLiquidity != null) filtered = filtered.filter((r) => (Number(r.liquidity_usd) || 0) >= minLiquidity)

    const sorters: Record<string, (a: Record<string, unknown>, b: Record<string, unknown>) => number> = {
      trending: (a, b) => (b.is_trending === true ? 1 : 0) - (a.is_trending === true ? 1 : 0) || n(b.momentum_score) - n(a.momentum_score) || n(b.volume_24h_usd) - n(a.volume_24h_usd),
      volume: (a, b) => n(b.volume_24h_usd) - n(a.volume_24h_usd),
      gainers: (a, b) => n(b.change_24h_pct) - n(a.change_24h_pct),
      losers: (a, b) => n(a.change_24h_pct) - n(b.change_24h_pct),
      liquidity: (a, b) => n(b.liquidity_usd) - n(a.liquidity_usd),
      new: (a, b) => new Date(String(b.pair_created_at || 0)).getTime() - new Date(String(a.pair_created_at || 0)).getTime(),
      market_cap: (a, b) => n(b.market_cap) - n(a.market_cap),
    }
    filtered = filtered.slice().sort(sorters[sort] || sorters.trending)

    const total = filtered.length
    const pageRows = filtered.slice(page * limit, page * limit + limit).map(rowOut)

    // snapshot over verified set
    const verifiedSet = all.filter(verified)
    const lastUpdated = all.reduce((m, r) => r.as_of && String(r.as_of) > m ? String(r.as_of) : m, '')
    const topGainer = verifiedSet.slice().sort((a, b) => n(b.change_24h_pct) - n(a.change_24h_pct))[0]
    const snapshot = {
      trackedMemecoins: all.length,
      verifiedCount: verifiedSet.length,
      newLaunches: all.filter((r) => r.is_new === true || r.listing_state === 'pre_liquidity').length,
      totalVolume24h: verifiedSet.reduce((s, r) => s + (Number(r.volume_24h_usd) || 0), 0),
      topGainerSymbol: topGainer?.symbol || null, topGainerChange: topGainer?.change_24h_pct ?? null,
      chains: [...new Set(all.map((r) => r.chain))],
      lastUpdated: lastUpdated || null,
    }

    return json({ snapshot, rows: pageRows, total, page, limit })
  } catch (e) {
    return json({ error: (e as Error)?.message || 'intel_degen_failed' }, 500)
  }
})

function emptySnap() { return { trackedMemecoins: 0, verifiedCount: 0, newLaunches: 0, totalVolume24h: 0, topGainerSymbol: null, topGainerChange: null, chains: [], lastUpdated: null } }

function rowOut(r: Record<string, unknown>) {
  return {
    chain: r.chain, tokenAddress: r.token_address, symbol: r.symbol, name: r.name,
    // Prefer our own mirrored copy (market-asset-logo-verify); the provider URL
    // stays alongside it as the client-side second chance before initials.
    imageUrl: r.cached_image_url ?? r.image_url, imageSourceUrl: r.image_url,
    imageFallbackType: r.image_fallback_type, imageVerifiedAt: r.image_verified_at ?? null,
    price: r.price_usd, change1hPct: r.change_1h_pct, change24hPct: r.change_24h_pct,
    volume24hUsd: r.volume_24h_usd, liquidityUsd: r.liquidity_usd, fdv: r.fdv, marketCap: r.market_cap,
    buys24h: r.buys_24h, sells24h: r.sells_24h, txns24h: r.txns_24h, pairAddress: r.pair_address, dexId: r.dex_id,
    socials: r.socials || {}, links: r.links || {}, pairCreatedAt: r.pair_created_at,
    isTrending: r.is_trending, isBoosted: r.is_boosted, isTakeover: r.is_takeover, isNew: r.is_new, isPumpfun: r.is_pumpfun, isMigrated: r.is_migrated,
    discoveryReasons: r.discovery_reasons || [], liquidityVerified: r.liquidity_verified, listingState: r.listing_state,
    momentumScore: r.momentum_score, riskScore: r.risk_score, riskFlags: r.risk_flags || [], signalDirection: r.signal_direction,
    source: r.source, sourceLabel: r.source_label, sourceUrl: r.source_url, attributionLabel: r.attribution_label,
    birdeyeEnriched: r.birdeye_enriched, lastRefreshedAt: r.last_refreshed_at, asOf: r.as_of,
    // drill-in to the entity detail (lazy Birdeye on open)
    detailHref: `/intel/asset/${encodeURIComponent(`${r.chain}:${r.token_address}`)}`,
  }
}
