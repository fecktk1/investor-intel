import {assertEquals as eq} from 'jsr:@std/assert@1'
import {loadAssetHistory,historyPlan,historyPoints,HISTORY_RANGES,unavailableHistory} from './asset-history.ts'

const NOW=Date.parse('2026-09-14T12:00:00Z'),DAY=86400000
const provenance=(fetchedAt:string|null='2026-09-14T11:59:00.000Z')=>({provider:'coinmarketcap' as const,observedAt:null,fetchedAt,expiresAt:null,sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview'})
const quote=(t:number,price:number,volume:number|null=1,marketCap:number|null=2)=>({timestamp:new Date(t).toISOString(),quote:{USD:{price,volume_24h:volume,market_cap:marketCap,timestamp:new Date(t).toISOString()}}})
const payload=(id:string,points:{t:number;price:number}[])=>({data:{[id]:{id:Number(id),name:'Ethereum',symbol:'ETH',quotes:points.map(p=>quote(p.t,p.price))}},status:{error_code:0}})
function stub(result:any){
 const calls:{name:string;params:Record<string,unknown>;maxCalls:unknown;orgId:unknown;userId:unknown}[]=[]
 const request=((name:string,params:Record<string,unknown>,ctx:any)=>{calls.push({name,params,maxCalls:ctx?.maxCalls,orgId:ctx?.orgId,userId:ctx?.userId});return Promise.resolve(result)}) as any
 return {calls,request}
}
const admin={} as any

Deno.test('each range samples one interval inside the provider ceiling at its documented credit cost',()=>{
 eq(Object.entries(HISTORY_RANGES).map(([range,plan])=>[range,plan.interval,plan.count,historyPlan(range)!.credits]),
  [['1y','daily',366,4],['90d','daily',90,1],['30d','hourly',720,8],['7d','hourly',168,2],['48h','5m',576,6]])
 eq(historyPlan('2y'),null);eq(historyPlan(''),null);eq(historyPlan(undefined),null)
})
Deno.test('a range is exactly one provider request, with the range interval and count',async()=>{
 for(const [range,plan] of Object.entries(HISTORY_RANGES)){
  const s=stub({payload:payload('1027',[{t:NOW-2*DAY,price:100},{t:NOW-DAY,price:101},{t:NOW,price:102}]),state:'fresh',reason:null,provenance:provenance()})
  const history=await loadAssetHistory(admin,{cmcId:'1027',range,ctx:{orgId:'org',userId:'user'},request:s.request,now:NOW})
  eq(s.calls.length,1)
  eq(s.calls[0].name,'history')
  eq(s.calls[0].params,{id:'1027',interval:plan.interval,count:String(plan.count)})
  // One request budget, and no demand recorded for a replayable window.
  eq(s.calls[0].maxCalls,1);eq(s.calls[0].orgId,undefined);eq(s.calls[0].userId,undefined)
  eq(history.interval,plan.interval);eq(history.state,'fresh');eq(history.source,'coinmarketcap')
  eq(history.points.length,3);eq(history.observedAt,new Date(NOW).toISOString());eq(history.fetchedAt,'2026-09-14T11:59:00.000Z')
 }
})
Deno.test('a refused or failed request is unavailable with the transport reason, never an empty series as data',async()=>{
 for(const [state,reason] of [['unavailable','rate_limited'],['unsupported','insufficient_entitlement'],['unavailable','budget_exceeded']] as const){
  const s=stub({payload:null,state,reason,provenance:provenance(null)})
  const history=await loadAssetHistory(admin,{cmcId:'1027',range:'1y',request:s.request,now:NOW})
  eq(s.calls.length,1);eq(history.state,'unavailable');eq(history.reason,reason);eq(history.points,[]);eq(history.observedAt,null);eq(history.credits,4)
 }
 const empty=stub({payload:{data:{}},state:'fresh',reason:null,provenance:provenance()})
 const none=await loadAssetHistory(admin,{cmcId:'1027',range:'90d',request:empty.request,now:NOW})
 eq(none.state,'unavailable');eq(none.reason,'no_history_points');eq(none.points,[])
 const thrown=await loadAssetHistory(admin,{cmcId:'1027',range:'90d',request:(()=>Promise.reject(new Error('boom'))) as any,now:NOW})
 eq(thrown.state,'unavailable');eq(thrown.reason,'provider_unavailable')
})
Deno.test('a served cache keeps its points and reports stale rather than fresh',async()=>{
 const s=stub({payload:payload('1027',[{t:NOW-2*DAY,price:100},{t:NOW-DAY,price:101},{t:NOW,price:102}]),state:'refreshing',reason:'refreshing',provenance:provenance()})
 const history=await loadAssetHistory(admin,{cmcId:'1027',range:'90d',request:s.request,now:NOW})
 eq(history.state,'stale');eq(history.reason,'refreshing');eq(history.points.length,3)
})
Deno.test('an asset without a CoinMarketCap listing never reaches the provider',async()=>{
 for(const id of [null,undefined,'','0','solana:So11111111111111111111111111111111111111112']){
  const s=stub({payload:null,state:'fresh',reason:null,provenance:provenance()})
  const history=await loadAssetHistory(admin,{cmcId:id,range:'90d',request:s.request,now:NOW})
  eq(s.calls.length,0);eq(history.state,'unavailable');eq(history.reason,'no_coinmarketcap_listing');eq(history.credits,0)
 }
 const s=stub({payload:null,state:'fresh',reason:null,provenance:provenance()})
 const bad=await loadAssetHistory(admin,{cmcId:'1027',range:'5y',request:s.request,now:NOW})
 eq(s.calls.length,0);eq(bad.reason,'unsupported_history_range');eq(bad.credits,0)
 eq(unavailableHistory('48h','no_coinmarketcap_listing'),{points:[],interval:'5m',source:'coinmarketcap',observedAt:null,fetchedAt:null,state:'unavailable',reason:'no_coinmarketcap_listing',credits:0})
})
Deno.test('points are sorted, deduplicated by time, finite and never dated into the future',()=>{
 const body={data:{'1027':{id:1027,quotes:[
  quote(NOW,102),quote(NOW-2*DAY,100),quote(NOW-DAY,101),
  {timestamp:new Date(NOW-DAY).toISOString(),quote:{USD:{price:999,volume_24h:9,market_cap:9}}},
  quote(NOW+DAY,500),
  {timestamp:'not-a-date',quote:{USD:{price:7}}},
  {timestamp:new Date(NOW-3*DAY).toISOString(),quote:{USD:{price:null,volume_24h:1,market_cap:2}}},
 ]}}}
 const points=historyPoints(body,'1027',NOW)
 eq(points.map(p=>p.t),[NOW-2*DAY,NOW-DAY,NOW])
 eq(points.map(p=>p.price),[100,101,102])
 eq(points[0],{t:NOW-2*DAY,price:100,volume:1,marketCap:2})
})
Deno.test('a shared response never lends another asset its history',()=>{
 const body={data:{'1':{id:1,quotes:[quote(NOW,60000)]},'1027':{id:1027,quotes:[quote(NOW,3000),quote(NOW-DAY,2900)]}}}
 eq(historyPoints(body,'1027',NOW).map(p=>p.price),[2900,3000])
 eq(historyPoints(body,'1',NOW).map(p=>p.price),[60000])
 eq(historyPoints(null,'1027',NOW),[])
 eq(historyPoints({data:{'1027':{id:1027,quotes:'nope'}}},'1027',NOW),[])
})
