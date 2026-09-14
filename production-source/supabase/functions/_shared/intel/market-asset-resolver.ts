import {resolveCmcAsset} from './cmc-asset-identity.ts'
/** Bare legacy URLs retain the CoinGecko namespace. Never merge equal tickers. */
export async function resolveMarketAsset(admin:any,symbol:string,provider?:string,id?:string,resolveCmc=resolveCmcAsset){
 if((provider&&!id)||(!provider&&id))return {data:null,error:'incomplete_identity',ambiguous:false}
 if(provider&&!['coingecko','coinmarketcap'].includes(provider))return {data:null,error:'invalid_provider',ambiguous:false}
 for(const source of provider?[provider]:['coingecko','coinmarketcap']){
  let query=admin.from('market_assets').select('*',{count:'exact'}).eq('source_provider',source)
  query=id?query.eq('provider_id',id):query.eq('normalized_symbol',symbol)
  const result=await query.limit(2)
  if(result.error)return {data:null,error:result.error,ambiguous:false}
  if((result.count??result.data?.length??0)>1)return {data:null,error:null,ambiguous:true}
  if(result.data?.length===1)return {data:result.data[0],error:null,ambiguous:false}
 }
 if(provider==='coinmarketcap'&&id)return resolveCmc(admin,id)
 return {data:null,error:null,ambiguous:false}
}
