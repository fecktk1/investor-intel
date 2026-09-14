import {getChain,CHAIN_COINGECKO} from '../chains.ts'
import {nativeCmcId} from './cmc-chart.ts'
// Chain labels describe the network; prices describe its native asset. L2
// governance-token snapshots must never be presented as the gas token's price.
export function nativeChainPerformance(chains:{id:string;label:string}[],rows:Record<string,any>[],now=Date.now()){
 return chains.flatMap(c=>{
  const chain=getChain(c.id),providerId=CHAIN_COINGECKO[c.id]
  if(!chain||!providerId)return []
  const row=rows.filter(r=>(r.provider==='coinmarketcap'?r.provider_id===nativeCmcId(c.id):r.coingecko_id===providerId)&&r.symbol===chain.nativeSymbol&&Number.isFinite(Number(r.price))&&Number(r.price)>0&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)<=now&&Date.parse(r.updated_at)>=now-6*3600000)
    .sort((a,b)=>Number(b.provider==='coinmarketcap'&&Date.parse(b.updated_at)>=now-15*60000)-Number(a.provider==='coinmarketcap'&&Date.parse(a.updated_at)>=now-15*60000)||Date.parse(b.updated_at)-Date.parse(a.updated_at))[0]
  return row?[{chain_id:c.id,ref:`native:${c.id}`,label:c.label,symbol:chain.nativeSymbol,price:Number(row.price),change_24h:row.change_24h,market_cap:row.market_cap,as_of:row.updated_at,source:row.provider==='coinmarketcap'?'coinmarketcap':'coingecko',stale:Date.parse(row.updated_at)<now-15*60000}]:[]
 }).sort((a,b)=>(b.change_24h??-999)-(a.change_24h??-999))
}
