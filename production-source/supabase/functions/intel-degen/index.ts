// Investor Intel — Degen (memecoin) read API. Reads memecoin_latest_tokens ONLY
// (cache-only; never a live provider call). Quality-gated buckets (G4): Hot/
// Trending/Established/High-Liquidity/High-Volume require verified market data;
// pre-liquidity launches surface ONLY in New Launches / Pump.fun (G3). Every row
// carries discovery_reasons + source; rows without them are never returned.
//
// Before any of that, every row goes through the exclusion gate
// (_shared/memecoin/degen-gate.ts): stablecoins, majors, wrapped/staked
// receipts, homoglyph impersonations and impossible market caps are not
// memecoins and never appear in the screener. They are counted by reason and
// can be listed on request (`showExcluded`), so the reader can see what was
// removed instead of wondering where USDT went.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { contractKey } from '../_shared/memecoin/degen-gate.ts'
import { applyDegenQuery, DegenQueryError, emptyDegenExclusions, emptyDegenSnapshot, isDegenSortKey } from '../_shared/memecoin/degen-query.ts'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' }
function json(b: unknown, s = 200) { return new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }) }

// The catalogue is the only thing that can excuse a multi-billion market cap,
// and it changes on the hour at most. One read per cold function instance per
// five minutes, shared by every request that instance serves.
const CATALOGUE_TTL_MS = 5 * 60_000
const CATALOGUE_PAGE = 1000
const CATALOGUE_MAX_ROWS = 10_000
let cataloguePromise: Promise<Set<string>> | null = null
let catalogueAt = 0

// Structural: the generated client type carries generics that do not survive a
// ReturnType<> round trip, and this module only ever reads one table.
// deno-lint-ignore no-explicit-any
type CatalogueReader = { from: (table: string) => any }

async function readCatalogueContracts(admin: CatalogueReader): Promise<Set<string>> {
  const keys = new Set<string>()
  for (let offset = 0; offset < CATALOGUE_MAX_ROWS; offset += CATALOGUE_PAGE) {
    // PostgREST truncates an unbounded read silently, so page explicitly and
    // stop on the first short page rather than trusting a single large limit.
    const { data, error } = await admin.from('market_assets').select('platforms')
      .eq('source_provider', 'coinmarketcap').eq('in_current_catalog', true)
      .range(offset, offset + CATALOGUE_PAGE - 1)
    if (error || !data?.length) break
    for (const row of data) {
      const platforms = (row as { platforms?: unknown }).platforms
      if (!platforms || typeof platforms !== 'object') continue
      for (const [chain, address] of Object.entries(platforms as Record<string, unknown>)) {
        const key = contractKey(chain, address)
        if (key) keys.add(key)
      }
    }
    if (data.length < CATALOGUE_PAGE) break
  }
  return keys
}

function catalogueContracts(admin: CatalogueReader): Promise<Set<string>> {
  const now = Date.now()
  if (!cataloguePromise || now - catalogueAt > CATALOGUE_TTL_MS) {
    catalogueAt = now
    // A failed read must not poison the cache for five minutes: drop it so the
    // next request retries, and fall back to an empty set for this one.
    cataloguePromise = readCatalogueContracts(admin).catch(() => { cataloguePromise = null; return new Set<string>() })
  }
  return cataloguePromise
}

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
    const bucket = body.bucket ? String(body.bucket) : null
    // Rejected before any table read: a bad sort key is a caller bug, and it
    // must not cost a full token scan to find that out.
    if (body.sort != null && body.sort !== '' && !isDegenSortKey(body.sort)) return json({ error: 'invalid_sort' }, 400)

    let tokensR
    try { tokensR = await admin.from('memecoin_latest_tokens').select('*').order('volume_24h_usd', { ascending: false, nullsFirst: false }).limit(2000) }
    catch { return json({ snapshot: emptyDegenSnapshot(), rows: [], total: 0, page, limit, sort: 'trending', dir: 'desc', showExcluded: false, excluded: emptyDegenExclusions() }) }
    const all = (tokensR?.data || []).filter((r: Record<string, unknown>) => Array.isArray(r.discovery_reasons) && (r.discovery_reasons as unknown[]).length > 0 && r.source)

    // watchlist set (degen tokens by chain:contract)
    let watchSet: Set<string> | null = null
    if (bucket === 'watchlist' && orgId) {
      const { data: wl } = await admin.from('watchlist_items').select('entity:entities(chain, contract_address)').eq('org_id', orgId)
      watchSet = new Set((wl || []).map((w) => { const e = (w.entity as { chain?: string; contract_address?: string }); return e?.chain && e?.contract_address ? `${String(e.chain).toLowerCase()}:${String(e.contract_address).toLowerCase()}` : null }).filter(Boolean) as string[])
    }

    const catalogue = await catalogueContracts(admin)

    const result = applyDegenQuery(all, {
      page: body.page, limit: body.limit, sort: body.sort, dir: body.dir, search: body.search,
      chain: body.chain, bucket: body.bucket, riskMax: body.riskMax, minLiquidity: body.minLiquidity,
      showExcluded: body.showExcluded,
    }, { catalogueContracts: catalogue, watchSet, now: Date.now(), mapRow: rowOut })

    return json(result)
  } catch (e) {
    if (e instanceof DegenQueryError) return json({ error: e.code }, e.status)
    return json({ error: (e as Error)?.message || 'intel_degen_failed' }, 500)
  }
})

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
