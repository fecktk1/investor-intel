import assert from 'node:assert/strict'
import {CMC_CAPABILITIES} from './cmc-capabilities.ts'
import {cmcDemandPolicy,connectedDemandEnabled,selectedCmcReadPolicy} from './cmc-demand-policy.ts'
import {normalizeCmcOperatingSettings} from './cmc-operating-settings.ts'
import {planCmcRefresh,refreshCmcDemand} from './cmc-refresh-planner.ts'

Deno.test('connected refresh requires explicit policy; either disable wins and no tier is granted',()=>{
 assert.equal(connectedDemandEnabled({},()=>undefined),false)
 const configured=normalizeCmcOperatingSettings({CMC_CONNECTED_DEMAND_ENABLED:'true'})
 assert.equal(connectedDemandEnabled(configured,()=>undefined),true)
 assert.equal(connectedDemandEnabled(configured,()=> 'false'),false)
 assert.equal(connectedDemandEnabled({CMC_CONNECTED_DEMAND_ENABLED:'off'},()=> 'true'),false)
 assert.equal(cmcDemandPolicy('dexToken',{},'basic',true),null)
 assert.equal(cmcDemandPolicy('marketPairs',{},'startup',true),null)
})
Deno.test('all capabilities have a bounded selected-view policy or an explicit entitlement exclusion',()=>{
 for(const name of Object.keys(CMC_CAPABILITIES)){
  const policy=cmcDemandPolicy(name,{},'startup',true)
  if(policy){assert.equal(policy.demandSeconds,180);assert.ok(policy.cadenceSeconds>=CMC_CAPABILITIES[name].ttl)}
  // blockchainStats joined the Growth-only set after the 2026-09-14 probe answered 403 / 1006 on the Startup key.
  else assert.ok(['rwaPairs','marketPairs','content','community','blockchainStats'].includes(name))
 }
 assert.equal(cmcDemandPolicy('dexSwaps',{},'startup',false),null)
 assert.equal(cmcDemandPolicy('quotes',{},'basic',false)?.demandSeconds,1800)
 for(const params of [{lastId:'cursor'},{nextPageIndex:'cursor'},{time_end:'2026-09-12'},{time_start:'2026-09-01'},{start:26}])assert.equal(cmcDemandPolicy('quotes',params,'startup',true),null)
 assert.deepEqual(selectedCmcReadPolicy(['dexToken','dexHolderCount'],{},'startup',true),{enabled:true,cacheReadSeconds:60,providerRefreshSeconds:3600})
})
Deno.test('selected demand expires on departure and cannot defeat a cadence floor or lease',()=>{
 const now=Date.parse('2026-09-12T12:00:00Z'),row={capability:'dexToken',request_params:{platform:'ethereum',address:'0x'+'a'.repeat(40)},access_profile:'startup',cache_key:'contract',demand_org_id:'org',demand_user_id:'user',demanded_at:new Date(now-60000).toISOString(),expires_at:new Date(now-1000).toISOString(),fetched_at:new Date(now-600000).toISOString()}
 assert.equal(planCmcRefresh([row],'startup',now,true).length,1)
 for(const patch of [{demanded_at:new Date(now-180001).toISOString()},{fetched_at:new Date(now-599999).toISOString()},{fetched_at:null},{refresh_until:new Date(now+1000).toISOString()},{request_params:{...row.request_params,lastId:'cursor'}}])assert.equal(planCmcRefresh([{...row,...patch}],'startup',now,true).length,0)
 assert.equal(planCmcRefresh([row,row],'startup',now,true).length,1)
})
Deno.test('an overdue discovery burst cannot take every refresh slot ahead of price and regime',()=>{
 const now=Date.parse('2026-09-12T12:00:00Z'),base={request_params:{},access_profile:'startup',demand_org_id:'org',demand_user_id:'user',demanded_at:new Date(now).toISOString(),expires_at:new Date(now-10000).toISOString(),fetched_at:new Date(now-86400000).toISOString()}
 const rows=[...Array.from({length:20},(_,i)=>({...base,cache_key:`discovery-${i}`,capability:'dexNew'})),{...base,cache_key:'price',capability:'quotes'},{...base,cache_key:'regime',capability:'global'}]
 const plan=planCmcRefresh(rows,'startup',now,true)
 assert.ok(plan.some(r=>r.cache_key==='price'));assert.ok(plan.some(r=>r.cache_key==='regime'))
 assert.ok(plan.length<=8);assert.ok(plan.filter(r=>r.capability==='dexNew').length<=2)
})
Deno.test('the database candidate scan is bounded per feature and read failure cannot become idle success',async()=>{
 const now=Date.parse('2026-09-12T12:00:00Z'),queries:any[]=[],config={CMC_CONNECTED_DEMAND_ENABLED:'true',CMC_ACCESS_PROFILE:'hackathon',CMC_VERIFIED_HACKATHON_PLAN:'startup',CMC_HACKATHON_EXPIRES_AT:'2026-09-30T23:59:00Z'}
 const db=(fail=false)=>({from:(table:string)=>{
  if(table==='provider_quota_budgets'){const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:{config}})};return q}
  assert.equal(table,'market_data_response_cache');const input:any={};queries.push(input)
  const q:any={select:()=>q,eq:()=>q,in:(field:string,values:string[])=>{input[field]=values;return q},gte:()=>q,lte:()=>q,order:()=>q,limit:(value:number)=>{input.limit=value;return Promise.resolve({data:fail?null:[],error:fail?{message:'offline'}:null})}};return q
 }})
 assert.equal(await refreshCmcDemand(db(),now),'idle');assert.equal(queries.length,7)
 assert.ok(queries.every(q=>q.limit===12));assert.equal(new Set(queries.flatMap(q=>q.capability)).size,61)
 queries.length=0;assert.equal(await refreshCmcDemand(db(true),now),'error')
})
