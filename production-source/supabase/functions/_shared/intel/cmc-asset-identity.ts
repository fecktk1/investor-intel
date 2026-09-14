import { cmcRows } from '../market-assets/cmc-capabilities.ts'
import { requestCmc } from '../market-assets/cmc-transport.ts'
import { mapCmcListing } from '../market-assets/coinmarketcap-provider.ts'
import { marketChain } from './market-read-quality.ts'
import { getChain } from '../chains.ts'
import type {MarketAssetsContext} from '../market-assets/types.ts'

/** CMC identity is never joined to another provider on a display symbol. */
export function cmcAssetRow(providerId:string,quoteBody:any,metadataBody:any,provenance:any=null,state='unavailable') {
  const exact=(name:string,body:any)=>body?cmcRows(name,body).rows.find(row=>String(row.id)===providerId):null
  const quote=exact('quotes',quoteBody),metadata=exact('metadata',metadataBody)
  if(!quote&&!metadata)return null
  const mapped=quote?mapCmcListing(quote):null,identity=metadata||quote
  if(!identity)return null
  const platforms:Record<string,string>={}
  for(const platform of [metadata?.platform,quote?.platform]) {
    if(!platform||!platform.token_address)continue
    const chain=marketChain(String(platform.slug||platform.name||'').toLowerCase())
    // Preserve unresolved platform names too: a missing registry entry must not
    // silently turn a multichain asset into a verified single-chain identity.
    const key=chain||`cmc-platform:${platform.id??'unknown'}`
    if(platforms[key]&&platforms[key]!==platform.token_address)platforms[`${key}:alternate`]=String(platform.token_address)
    else platforms[key]=String(platform.token_address)
  }
  const platformKeys=Object.keys(platforms),primaryChain=platformKeys.length===1&&getChain(platformKeys[0])?platformKeys[0]:null
  return {
    source_provider:'coinmarketcap',provider_id:providerId,provider_slug:identity.slug??null,
    name:identity.name??null,symbol:String(identity.symbol||'').toUpperCase(),normalized_symbol:String(identity.symbol||'').toUpperCase(),
    primary_chain:primaryChain,platforms:platformKeys.length?platforms:null,
    current_price:mapped?.currentPrice??null,market_cap:mapped?.marketCap??null,market_cap_rank:mapped?.marketCapRank??null,
    fdv:mapped?.fdv??null,circulating_supply:mapped?.circulatingSupply??null,total_supply:mapped?.totalSupply??null,max_supply:mapped?.maxSupply??null,
    volume_24h:mapped?.volume24h??null,change_1h_pct:mapped?.change1hPct??null,change_24h_pct:mapped?.change24hPct??null,change_7d_pct:mapped?.change7dPct??null,
    image_url:typeof metadata?.logo==='string'&&metadata.logo.startsWith('https://')?metadata.logo:null,
    categories:Array.isArray(metadata?.tags)?metadata.tags.slice(0,50):null,
    as_of:mapped?new Date(mapped.asOf).toISOString():null,source_freshness:state,provenance,
  }
}

export async function resolveCmcAsset(admin:any,providerId:string,request=requestCmc,context:MarketAssetsContext={}) {
  if(!/^\d{1,10}$/.test(providerId))return {data:null,error:'invalid_cmc_identity',ambiguous:false}
  const ctx={...context,supabase:admin,kind:'request' as const,caller:'intel-markets-identity',maxCalls:2}
  const quote=await request('quotes',{id:providerId},ctx)
  const metadata=await request('metadata',{id:providerId},ctx)
  const data=cmcAssetRow(providerId,quote.payload,metadata.payload,quote.provenance,quote.state)
  return {data,error:data?null:quote.reason||metadata.reason||'identity_unavailable',ambiguous:false}
}
