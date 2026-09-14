import {researchIdentity,researchCmcId} from './research-identity.ts'
import {readAssetSpecialistEvidence} from './asset-specialist-evidence.ts'
import {hasVerifiedCexIdentity} from './market-read-quality.ts'
import {positionDepthQuotes} from './position-depth.ts'
import {readConnectedAssetIdentity} from './connected-asset-identity.ts'
const nativeCg:Record<string,string>={'1':'bitcoin','1027':'ethereum','5426':'solana','1839':'binancecoin','5805':'avalanche-2'}
export async function readAssetVenueContext(db:any,params:any,refresh?:((capability:string,params:Record<string,string>)=>Promise<any>),now=Date.now()){
 const key=params?.canonicalKey
 if(typeof key!=='string'||key.length>240||!key||/\s|[\u0000-\u001f]/.test(key)||params.refresh!=null&&typeof params.refresh!=='boolean')throw Error('invalid_venue_identity')
 const identity=researchIdentity({canonicalKey:key}),linked=await readConnectedAssetIdentity(db,key),cmc=linked.cmcId
 const refreshResults:any[]=[]
 if(params.refresh===true){
  if(!cmc)refreshResults.push({state:'unsupported',reason:'No verified CoinMarketCap ID for these derivative sources.'})
  else if(!refresh)throw Error('venue_refresh_unavailable')
  else for(const capability of ['derivativePairs','liquidationAssets']){
   try{const r=await refresh(capability,{crypto_id:cmc,start:'1',limit:'50'});refreshResults.push({capability,state:r.state,reason:r.reason||null})}catch{refreshResults.push({capability,state:'error',reason:'Shared source refresh failed. Existing evidence retains its original dates.'})}
  }
  now=Date.now()
 }
 const [specialist,depth]=await Promise.all([readAssetSpecialistEvidence(db,{canonicalKey:key},now,{linked,identityError:false}),(async()=>{
  const base={quotes:[] as any[],status:'unavailable',reason:'A verified exchange mapping and a fresh USD best-level price and quantity are required.'}
  if(!identity.sourceProvider||!identity.providerId)return {...base,status:'unsupported',reason:'No verified provider identity for exchange depth. Contract identity alone does not establish a centralized venue pair.'}
  try{
   let asset=await db.from('market_assets').select('source_provider,provider_id,normalized_symbol,platforms').eq('source_provider',identity.sourceProvider).eq('provider_id',identity.providerId).maybeSingle()
   if(asset.error)throw asset.error
   if(!asset.data&&cmc&&nativeCg[cmc])asset=await db.from('market_assets').select('source_provider,provider_id,normalized_symbol,platforms').eq('source_provider','coingecko').eq('provider_id',nativeCg[cmc]).maybeSingle()
   if(asset.error)throw asset.error
   if(!asset.data?.normalized_symbol)return base
   const mapping=await db.from('exchange_asset_mappings').select('canonical_asset_id,chain,contract_address,is_active').eq('normalized_symbol',asset.data.normalized_symbol).eq('is_active',true).maybeSingle()
   if(mapping.error)throw mapping.error
   if(!hasVerifiedCexIdentity(asset.data,mapping.data))return {...base,status:'unverified'}
   const [books,tickers]=await Promise.all([
    db.from('exchange_latest_orderbook').select('provider,provider_symbol,as_of,updated_at,bid_price,ask_price,bid_qty,ask_qty').eq('normalized_symbol',asset.data.normalized_symbol).order('as_of',{ascending:false}).limit(8),
    db.from('exchange_latest_tickers').select('provider,provider_symbol,quote_asset').eq('normalized_symbol',asset.data.normalized_symbol).limit(33)
   ])
   if(books.error||tickers.error||!Array.isArray(books.data)||!Array.isArray(tickers.data)||tickers.data.length>32)throw Error('bounded_depth_read_failed')
   const quotes=positionDepthQuotes(asset.data,true,books.data,tickers.data,now)
   return {...base,quotes,status:quotes.length?'available':'unavailable',reason:quotes.length?'Recorded best level only. No deeper book or fee schedule is inferred.':base.reason}
  }catch{return {...base,status:'error',reason:'The retained exchange mapping or depth read failed. This is not empty coverage.'}}
 })()])
 return {schemaVersion:1,canonicalKey:key,subject:cmc?`market:coinmarketcap:${cmc}`:key,evaluatedAt:new Date(now).toISOString(),derivatives:specialist.derivatives,cmcContract:specialist.contractEvidence,rwa:specialist.rwa,security:specialist.security,benchmark:specialist.benchmark,representation:specialist.representation,depth,refreshResults}
}
