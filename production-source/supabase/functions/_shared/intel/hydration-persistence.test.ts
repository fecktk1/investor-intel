import { assertEquals as eq, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'
import { persistHydrationRows, reserveBirdeyeHydration } from './hydration-persistence.ts'
const options={returning:'dedup_key',ignoreDuplicates:true}
Deno.test('hydration persistence reports only written rows, excluding existing duplicates',async()=>{
 for(const data of [[],[{dedup_key:'one'}],[{dedup_key:'one'},{dedup_key:'two'}]]){
  const db={from:()=>({upsert:(_rows:unknown,opts:unknown)=>{eq(opts,{onConflict:'dedup_key',ignoreDuplicates:true});return {select:async(column:string)=>{eq(column,'dedup_key');return {data}}}}})}
  eq(await persistHydrationRows(db,'snapshot',[{}],'dedup_key',options),data.length)
 }
})
Deno.test('hydration database errors, malformed responses and missing required writes fail honestly',async()=>{
 for(const result of [{error:{message:'internal provider details'}},{data:null},{data:[]}]){
  const db={from:()=>({upsert:()=>({select:async()=>result})})}
  await assertRejects(()=>persistHydrationRows(db,'snapshot',{},'id',{returning:'id'}),Error,'hydration_save_unavailable')
 }
})
Deno.test('Birdeye reservations use the shared atomic monthly account budget before calls',async()=>{
 const calls:any[]=[];const db={rpc:async(name:string,input:any)=>{calls.push({name,input});return {data:{allowed:true}}}}
 eq(await reserveBirdeyeHydration(db,40,new Date('2026-12-31T23:59:59Z')),true)
 eq(calls,[{name:'provider_budget_bump',input:{p_provider:'birdeye',p_data_type:'calls',p_period_start:'2026-12-01T00:00:00.000Z',p_period_end:'2027-01-01T00:00:00.000Z',p_calls:1,p_credits:40,p_soft_cap:36000,p_hard_cap:45000}}])
 eq(await reserveBirdeyeHydration({rpc:async()=>({data:{allowed:false}})},40),false)
})
Deno.test('missing or failed Birdeye budget proof cannot authorize provider spending',async()=>{
 for(const result of [{error:{message:'private failure'}},{data:null},{data:{}},{data:{allowed:'true'}}])await assertRejects(()=>reserveBirdeyeHydration({rpc:async()=>result},40),Error,'hydration_budget_unavailable')
 for(const value of [0,-1,NaN,Infinity])await assertRejects(()=>reserveBirdeyeHydration({rpc:()=>{throw Error('must not run')}},value),Error,'invalid_hydration_credits')
})
