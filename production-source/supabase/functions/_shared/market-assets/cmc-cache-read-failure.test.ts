import {assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {requestCmc} from './cmc-transport.ts'
Deno.test('failed shared-cache reads never masquerade as misses or authorize provider spending',async()=>{
 const names=['COINMARKETCAP_API_KEY','CMC_ENABLED','CMC_ACCESS_PROFILE','CMC_VERIFIED_BASELINE_PLAN'],values=['fixture','true','baseline','basic'],old=names.map(k=>Deno.env.get(k))
 names.forEach((k,i)=>Deno.env.set(k,values[i]))
 try{for(const throws of [false,true]){
  let reservations=0
  const db={rpc:async()=>{reservations++;return {error:{message:'unexpected reservation'}}},from:(table:string)=>{
   const q:any={select:()=>q,eq:()=>q,insert:async()=>({error:null}),maybeSingle:async()=>{if(table!=='market_data_response_cache')return {data:null};if(throws)throw Error('private socket error');return {error:{message:'private database error'}}}}
   return q
  }}
  const result=await requestCmc('metadata',{id:'1027'},{supabase:db,kind:'request',maxCalls:1})
  eq(result.state,'unavailable');eq(result.reason,'cache_unavailable');eq(result.payload,null);eq(reservations,0)
 }}finally{names.forEach((k,i)=>old[i]===undefined?Deno.env.delete(k):Deno.env.set(k,old[i]!))}
})
