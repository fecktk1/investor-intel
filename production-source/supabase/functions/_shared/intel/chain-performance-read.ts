import {CHAINS} from '../chains.ts'
import {nativeCmcId} from './cmc-chart.ts'
import {nativeChainPerformance} from './chain-performance.ts'
import {requestCmc} from '../market-assets/cmc-transport.ts'
import {CMC_FOCUS_IDS} from '../market-assets/cmc-quote-groups.ts'
import {cmcRows,cmcUsdQuote} from '../market-assets/cmc-capabilities.ts'
/** Public shared snapshots only. A screen view never warms a provider. */
export async function readNativeChainPerformance(db:any,request=requestCmc){
 const ids=[...new Set(CHAINS.map(c=>nativeCmcId(c.id)).filter(Boolean))]
 const [cached,cmc,catalog]=await Promise.all([
  db.from('intel_chain_perf').select('chain_id,coingecko_id,symbol,price,change_24h,market_cap,updated_at').limit(100),
  request('quotes',{id:CMC_FOCUS_IDS.join(',')},{supabase:db,kind:'render',maxCalls:0,caller:'markets-native-snapshots'}),
  db.from('market_assets').select('provider_id,normalized_symbol,current_price,change_24h_pct,market_cap,as_of').eq('source_provider','coinmarketcap').in('provider_id',ids).limit(100)
 ])
 const quotes=cmcRows('quotes',cmc.payload).rows.map(row=>{const q=cmcUsdQuote(row);return {provider:'coinmarketcap',provider_id:String(row.id),symbol:row.symbol,price:q.price,change_24h:q.percent_change_24h,market_cap:q.market_cap,updated_at:q.last_updated||row.last_updated}})
 const catalogRows=(catalog.error?[]:catalog.data||[]).map((row:any)=>({provider:'coinmarketcap',provider_id:row.provider_id,symbol:row.normalized_symbol,price:row.current_price,change_24h:row.change_24h_pct,market_cap:row.market_cap,updated_at:row.as_of}))
 return {rows:nativeChainPerformance(CHAINS,[...quotes,...catalogRows,...(cached.error?[]:cached.data||[])]),unavailable:!!cached.error&&!!catalog.error&&!quotes.length}
}
