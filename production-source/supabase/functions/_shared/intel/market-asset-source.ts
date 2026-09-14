import {issuerProviderCmcId} from '../market-assets/issuer-identities.ts'
import {marketCanonicalIdentity} from './market-read-quality.ts'

const native:Record<string,{cmcId:string;chain:string}>={
 'bip122:native:BTC':{cmcId:'1',chain:'bitcoin'},'eip155:1:native':{cmcId:'1027',chain:'ethereum'},
 'solana:native:SOL':{cmcId:'5426',chain:'solana'},'eip155:56:native':{cmcId:'1839',chain:'bnb'},
 'eip155:43114:native':{cmcId:'5805',chain:'avalanche'},
}
export function marketCmcIdentity(asset:any){
 if(asset?.source_provider==='coinmarketcap'&&/^[1-9][0-9]{0,9}$/.test(String(asset.provider_id)))return String(asset.provider_id)
 const issuer=issuerProviderCmcId(asset?.source_provider,String(asset?.provider_id)); if(issuer)return issuer
 const key=marketCanonicalIdentity(asset).canonicalAssetKey
 return key?native[key]?.cmcId||null:null
}
/** Keep the journal/portfolio identity unchanged when the price provider changes. */
export function assetMarketRead(asset:any,cmc:any=null){
 const id=marketCmcIdentity(asset),valid=cmc?.source_provider==='coinmarketcap'&&String(cmc.provider_id)===id
 const quote=valid&&cmc.current_price!=null?cmc:asset
 const key=marketCanonicalIdentity(asset).canonicalAssetKey
 return {price:quote?.current_price??null,change1h:quote?.change_1h_pct??null,change24h:quote?.change_24h_pct??null,change7d:quote?.change_7d_pct??null,volume24h:quote?.volume_24h??null,
  marketCap:{market_cap:quote?.market_cap??null,fdv:quote?.fdv??null,circulating_supply:quote?.circulating_supply??null,market_cap_source:quote?.source_provider||null},
  imageUrl:(valid?cmc.image_url:null)||asset?.image_url||null,chain:(key?native[key]?.chain:null)||asset?.primary_chain||null,
  displayName:asset?.name||null,quoteProvider:quote?.source_provider||null,quoteProviderId:quote?.provider_id||null,
  asOf:quote?.as_of||null,provenance:quote?.provenance||null,sourceFreshness:quote?.source_freshness||null,
  quoteRefreshSeconds:quote?.source_provider==='coinmarketcap'?(Object.values(native).some(x=>x.cmcId===String(quote.provider_id))?60:300):null}
}
/** Prefer genuine CMC OHLCV for verified IDs, retaining one clearly labeled fallback. */
export async function chooseMarketCandles(asset:any,loadCmc:(id:string)=>Promise<any>,fallback:()=>Promise<any>){
 const id=marketCmcIdentity(asset)
 if(id){
  let cmc:any
  try{cmc=await loadCmc(id)}catch{cmc={candles:[],sourceState:'unavailable',sourceReason:'provider_unavailable'}}
  if(cmc.candles?.length)return cmc
  const alternative=await fallback()
  if(alternative.candles?.length)return {...alternative,coverage:`${alternative.coverage||''} CoinMarketCap OHLCV unavailable (${cmc.sourceReason||'no_completed_candles'}); showing ${alternative.bestProvider||alternative.source||'alternate source'} history.`,fallbackReason:cmc.sourceReason||'no_completed_candles'}
  return cmc
 }
 return fallback()
}
