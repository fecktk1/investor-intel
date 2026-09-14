import {assertEquals,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {refreshMarketMacroSnapshots} from './market-macro.ts'
const now=new Date('2026-09-12T12:00:00Z')
const config={CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_HISTORY_RETENTION_DAYS:'30',CMC_SOURCE_POLICY_EXPIRES_AT:'2026-09-30T23:59:00Z'}
function fixture(policy:any=config,error=false){
 const calls:string[]=[],writes:any[]=[]
 const db={from(table:string){const q:any={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{config:policy},error:error?{}:null}),upsert:async(rows:any[])=>{writes.push([table,rows]);return {error:null}}};return q}}
 const client={enabled:()=>true,fetchGlobal:async()=>{calls.push('global');return {data:{last_updated:now.toISOString(),quote:{USD:{total_market_cap:0}}}}},fetchRankings:async()=>{calls.push('rankings');return [{sourceProvider:'coinmarketcap',providerId:'1',marketCapRank:1,currentPrice:0,marketCap:0,asOf:now.getTime()} as any]}}
 return {db,client,calls,writes}
}
Deno.test('macro refresh uses the shared approved retention policy without an environment activation',async()=>{
 const f=fixture(),r=await refreshMarketMacroSnapshots(f.db,{now,providers:['coinmarketcap'],clients:{coinmarketcap:f.client},env:()=>undefined})
 assertEquals(r.providersAttempted,['coinmarketcap']);assertEquals(r.rankingRows,1);assertEquals(r.macroRows,1)
 assertEquals(f.calls,['global','rankings']);assertEquals(f.writes[0][1][0].total_market_cap_usd,0)
 assertEquals(f.writes[1][1][0].provider_id,'1');assertEquals(f.writes[1][1][0].as_of,now.toISOString())
})
Deno.test('denied expired invalid or unreadable policy makes zero CMC requests and explains the skip',async()=>{
 for(const [policy,error,env]of [
  [config,false,(k:string)=>k==='CMC_ALLOW_HISTORICAL_RETENTION'?'false':undefined],
  [{...config,CMC_SOURCE_POLICY_EXPIRES_AT:now.toISOString()},false,()=>undefined],
  [{...config,CMC_SOURCE_POLICY_EXPIRES_AT:'invalid'},false,()=>undefined],
  [config,true,()=>undefined], [{},false,()=>undefined],
 ] as any[]){
  const f=fixture(policy,error),r=await refreshMarketMacroSnapshots(f.db,{now,providers:['coinmarketcap'],clients:{coinmarketcap:f.client},env})
  assertEquals(f.calls,[]);assertEquals(f.writes,[]);assertEquals(r.skipReasons.coinmarketcap,'retention_policy_unavailable')
 }
})
Deno.test('provider failures are observable and never manufacture ranking rows',async()=>{
 const f=fixture(),client={...f.client,fetchRankings:async()=>{throw Error('upstream failed')},fetchGlobal:async()=>null}
 const r=await refreshMarketMacroSnapshots(f.db,{now,providers:['coinmarketcap'],clients:{coinmarketcap:client},env:()=>undefined})
 assertEquals(r.rankingRows,0);assertEquals(r.macroRows,0);assertEquals(r.providerErrors,['coinmarketcap:global_unavailable','coinmarketcap:rankings_unavailable']);assertEquals(f.writes,[])
})
Deno.test('ineligible credentials remain separate from retention permission',async()=>{
 const f=fixture(),r=await refreshMarketMacroSnapshots(f.db,{now,providers:['coinmarketcap'],clients:{coinmarketcap:{...f.client,enabled:()=>false}},env:()=>undefined})
 assertEquals(r.skipReasons.coinmarketcap,'provider_disabled_or_credentials_missing');assert(!f.calls.length)
})
