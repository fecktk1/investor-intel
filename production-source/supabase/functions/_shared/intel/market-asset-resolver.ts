import {resolveCmcAsset} from './cmc-asset-identity.ts'
import {buildContractMarketAsset,parseContractProviderId} from './contract-market-asset.ts'
/** Bare legacy URLs retain the CoinGecko namespace. Never merge equal tickers. */
export async function resolveMarketAsset(admin:any,symbol:string,provider?:string,id?:string,resolveCmc=resolveCmcAsset,buildContract=buildContractMarketAsset){
 if((provider&&!id)||(!provider&&id))return {data:null,error:'incomplete_identity',ambiguous:false}
 // A pasted contract is its own exact identity — one chain, one address, never
 // a symbol match. It resolves from the on-chain sources, not the catalogue.
 if(provider==='contract'){
  const parsed=parseContractProviderId(String(id||''))
  if(!parsed)return {data:null,error:'invalid_provider',ambiguous:false}
  const data=await buildContract(admin,parsed.chain,parsed.address,{supabase:admin,jobName:'intel-markets',caller:'contract-identity'})
  return {data,error:null,ambiguous:false}
 }
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
