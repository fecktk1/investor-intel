import {digest,stableJson,type Observation} from './investigation-evidence.ts'
import {hasVerifiedCexIdentity} from './market-read-quality.ts'
import {positionDepthQuotes} from './position-depth.ts'
import {venueConditionObservations} from './venue-condition-sources.ts'

/** Cache-only, identity-verified depth for research. Retain no longer than the
 * existing 60-second snapshot lifetime; saved receipts contain references only. */
export async function normalizeInvestigationDepth(asset:any,verified:boolean,books:any[],tickers:any[],now:number){
 const quotes=positionDepthQuotes(asset,verified,books,tickers,now)
 const observations=await Promise.all(venueConditionObservations([],{quotes},now).map(async original=>{const o={...original,sourceRef:original.sourceRef+':'+original.metadata?.side};return {...o,id:'depth:'+await digest(stableJson(o))}}))
 return {observations,rows:observations.map(o=>({...o,retainUntil:o.expiresAt}))}
}
export async function readInvestigationDepth(db:any,cryptoId:string,now:number):Promise<{observations:Observation[];rows:any[]}>{
 if(!/^[1-9][0-9]{0,11}$/.test(cryptoId))throw Error('invalid_depth_identity')
 const read=async(q:any)=>{const {data,error}=await q;if(error)throw Error('investigation_depth_unavailable');return data}
 const asset=await read(db.from('market_assets').select('source_provider,provider_id,normalized_symbol,platforms').eq('source_provider','coinmarketcap').eq('provider_id',cryptoId).maybeSingle())
 if(!asset?.normalized_symbol)return {observations:[],rows:[]}
 const mapping=await read(db.from('exchange_asset_mappings').select('canonical_asset_id,chain,contract_address,is_active').eq('normalized_symbol',asset.normalized_symbol).eq('is_active',true).maybeSingle())
 if(!hasVerifiedCexIdentity(asset,mapping))return {observations:[],rows:[]}
 const [books,tickers]=await Promise.all([
  read(db.from('exchange_latest_orderbook').select('provider,provider_symbol,bid_price,ask_price,bid_qty,ask_qty,as_of,updated_at').eq('normalized_symbol',asset.normalized_symbol).order('as_of',{ascending:false}).limit(8)),
  read(db.from('exchange_latest_tickers').select('provider,provider_symbol,quote_asset').eq('normalized_symbol',asset.normalized_symbol).order('volume_quote_24h',{ascending:false}).limit(8)),
 ])
 return normalizeInvestigationDepth(asset,true,books||[],tickers||[],now)
}
