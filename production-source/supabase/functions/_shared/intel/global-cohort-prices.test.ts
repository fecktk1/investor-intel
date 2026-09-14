import {assertEquals,assertRejects} from 'jsr:@std/assert'
import {globalCohortPrices} from './global-cohort-prices.ts'
const now=Date.parse('2026-09-12T06:00:00Z'),at=now-60000,cohort={id:'cohort',kind:'sector',provider:'coinmarketcap',created_at:new Date(now-3600000).toISOString(),retain_until:new Date(now+3600000).toISOString(),members:[{subject:'market:coinmarketcap:1'},{subject:'market:coinmarketcap:2'}]}
const observation={subject:'market:coinmarketcap:1',metric:'price',provider:'coinmarketcap',unit:'USD',value:0,observedAt:new Date(at-1000).toISOString(),recordedAt:new Date(at-500).toISOString(),expiresAt:new Date(at+1000).toISOString()}
Deno.test('global cohort reads one original basket at the exact cursor, retaining missing members and valid zero',async()=>{
 const calls:any[]=[],data=[{subject:observation.subject,observation},{subject:'market:coinmarketcap:2',observation:null}],db={rpc:(...args:any[])=>{calls.push(args);return {data}}}
 const result=await globalCohortPrices(db,cohort,at,now)
 assertEquals(calls,[['intel_global_cohort_quotes',{p_cohort:'cohort',p_at:new Date(at).toISOString()}]]);assertEquals(result.rows,data);assertEquals(result.state,'retained')
})
Deno.test('failed, malformed or incomplete cohort reads are failures, never empty histories',async()=>{
 for(const response of [{error:{}},{data:null},{data:[]},{data:[{subject:'market:coinmarketcap:1',observation},{subject:'market:coinmarketcap:1',observation}]},{data:[{subject:'market:coinmarketcap:1',observation:{...observation,recordedAt:new Date(now).toISOString()}},{subject:'market:coinmarketcap:2',observation:null}]}])await assertRejects(()=>globalCohortPrices({rpc:()=>response},cohort,at,now))
})
Deno.test('future cursors, duplicate or ambiguous members and expired retention cannot read prices',async()=>{
 let calls=0;const db={rpc:()=>{calls++;throw Error('Unexpected read')}}
 for(const time of [true,'',String(at),now+1,NaN])await assertRejects(()=>globalCohortPrices(db,cohort,time,now))
 for(const patch of [{members:[{subject:'BTC'}]},{members:[cohort.members[0],cohort.members[0]]},{provider:'coingecko'},{retain_until:new Date(at).toISOString()}])await assertRejects(()=>globalCohortPrices(db,{...cohort,...patch},at,now))
 assertEquals((await globalCohortPrices(db,cohort,now-7200000,now)).state,'not_yet_recorded');assertEquals(calls,0)
})
