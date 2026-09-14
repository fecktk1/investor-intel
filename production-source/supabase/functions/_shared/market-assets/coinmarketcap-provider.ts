// Market Assets — CoinMarketCap provider (OPTIONAL canonical source).
//
// Active only when COINMARKETCAP_API_KEY is set AND MARKET_ASSETS_PROVIDER points
// here (or as fallback). Uses /v1/cryptocurrency/listings/latest for the top-N
// universe; logos come from /v2/cryptocurrency/info (deep step). This exists so
// we can swap off CoinGecko's non-commercial free tier without touching the page.

import type { CanonicalAsset, MarketAssetsContext, MarketAssetsProvider } from './types.ts'
import { normSymbol, num } from './types.ts'
import { cmcApiKey, requestCmc } from './cmc-transport.ts'
import { cmcUsdQuote,cmcRows } from './cmc-capabilities.ts'

// deno-lint-ignore no-explicit-any
const _glob = globalThis as any
function env(name: string): string | undefined {
  try { const v = _glob?.Deno?.env?.get?.(name); if (v != null) return v } catch { /* */ }
  const pv = _glob?.process?.env?.[name]; return pv != null ? String(pv) : undefined
}
function apiKey(): string | undefined { return cmcApiKey() }

const ID = 'coinmarketcap' as const

export async function fetchCoinmarketcapGlobalMetrics(ctx?: MarketAssetsContext): Promise<unknown | null> {
  return (await requestCmc('global',{},ctx)).payload
}

// deno-lint-ignore no-explicit-any
export function mapCmcListing(c: any): CanonicalAsset | null {
  const providerId = c?.id != null ? String(c.id) : ''
  const symbol = String(c?.symbol || '').trim()
  if (!providerId || !symbol) return null
  const q = cmcUsdQuote(c)
  const observed = Date.parse(String(q.last_updated || c.last_updated || ''))
  // An unknown observation time must not masquerade as a fresh snapshot.
  if (!Number.isFinite(observed) || observed > Date.now()+300000) return null
  return {
    sourceProvider: ID, providerId, providerSlug: c?.slug ?? null,
    symbol: symbol.toUpperCase(), name: c?.name ?? null, normalizedSymbol: normSymbol(symbol), primaryChain: null,
    marketCapRank: num(c?.cmc_rank), currentPrice: num(q?.price), marketCap: num(q?.market_cap),
    fdv: num(q?.fully_diluted_market_cap), circulatingSupply: num(c?.circulating_supply), totalSupply: num(c?.total_supply), maxSupply: num(c?.max_supply),
    volume24h: num(q?.volume_24h),
    change1hPct: num(q?.percent_change_1h), change24hPct: num(q?.percent_change_24h), change7dPct: num(q?.percent_change_7d),
    categories: null, platforms: c?.platform?.name && c?.platform?.token_address ? { [String(c.platform.name).toLowerCase()]: String(c.platform.token_address) } : null,
    imageUrl: null, imageSource: null,   // logos via /v2/cryptocurrency/info (deep)
    asOf: observed,
  }
}

export async function fetchCoinmarketcapTopAssets(limit: number, ctx?: MarketAssetsContext, request=requestCmc): Promise<CanonicalAsset[] | null> {
  const context={...ctx,waitForFresh:true,maxCalls:ctx?.maxCalls??Math.min(40,Math.ceil(Math.min(limit,5000)/250)*2)}
  const perPage = 250
  const out: CanonicalAsset[] = []
  for (let start = 1; start <= Math.min(limit, 5000); start += perPage) {
    const count = Math.min(perPage, limit - start + 1)
    const body = (await request('listings',{start,limit:count,sort:'market_cap'},context)).payload
    const rows = body?.data
    if (!Array.isArray(rows)) return null // A partial failed catalogue must not replace a complete snapshot.
    for (const c of rows) { const a = mapCmcListing(c); if (a) out.push(a) }
    if (rows.length < count) break
  }
  // Metadata has a separate daily shared TTL. Broad quote refreshes reuse it;
  // failed metadata cannot erase the last good logo/platform enrichment.
  // Reuse each asset's verified metadata clock. Ranking or membership changes
  // must not force another metadata request for every existing asset in a batch.
  let prior=new Map<string,any>()
  if(ctx?.supabase?.from){
    const cached=await ctx.supabase.from('market_assets').select('provider_id,image_url,image_source,image_last_checked_at,categories,platforms').eq('source_provider','coinmarketcap').limit(5000)
    if(cached.error)return null
    prior=new Map((cached.data||[]).map((row:any)=>[String(row.provider_id),row]))
  }
  const metadataOrder=out.filter(asset=>{
    const cached=prior.get(asset.providerId),at=Date.parse(cached?.image_last_checked_at||'')
    if(!Number.isFinite(at)||at>Date.now()||Date.now()-at>=86400000)return true
    asset.imageUrl=cached.image_url;asset.imageSource=cached.image_source;asset.categories=cached.categories;asset.platforms=cached.platforms;asset.metadataFetchedAt=cached.image_last_checked_at
    return false
  }).sort((a,b)=>Number(a.providerId)-Number(b.providerId))
  for(let i=0;i<metadataOrder.length;i+=250){
    const assets=metadataOrder.slice(i,i+250)
    const metadata=await request('metadata',{id:assets.map(a=>a.providerId).sort((a,b)=>Number(a)-Number(b)).join(',')},context)
    const byId=new Map(cmcRows('metadata',metadata.payload).rows.map(row=>[String(row.id),row]))
    for(const asset of assets){const row=byId.get(asset.providerId);if(!row)continue
      asset.metadataFetchedAt=metadata.provenance?.fetchedAt||null
      if(typeof row.logo==='string'&&/^https:\/\//.test(row.logo)){asset.imageUrl=row.logo;asset.imageSource='coinmarketcap'}
      if(Array.isArray(row.tags))asset.categories=row.tags.filter((x:unknown)=>typeof x==='string').slice(0,50)
      if(row.platform?.token_address&&row.platform?.slug)asset.platforms={[row.platform.slug]:row.platform.token_address}
    }
  }
  return out.length ? out.slice(0, limit) : null
}

export const coinmarketcapProvider: MarketAssetsProvider = {
  id: ID,
  enabled() {
    if (!apiKey()) return false
    const v = env('ENABLE_COINMARKETCAP_MARKET_CAP')
    return v == null || v === '' ? true : /^(1|true|yes|on)$/i.test(v.trim())
  },
  fetchTopAssets:fetchCoinmarketcapTopAssets,
}
