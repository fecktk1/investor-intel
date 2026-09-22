import {assertEquals as eq,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {requestCmc} from './cmc-transport.ts'
const keys=['COINMARKETCAP_API_KEY','CMC_API_KEY','CMC_ENABLED','CMC_ACCESS_PROFILE','CMC_VERIFIED_BASELINE_PLAN','CMC_VERIFIED_HACKATHON_PLAN','CMC_HACKATHON_EXPIRES_AT','CMC_ALLOW_AI_PROCESSING','CMC_ALLOW_HISTORICAL_RETENTION','CMC_HISTORY_RETENTION_DAYS','CMC_SOURCE_POLICY_EXPIRES_AT','CMC_ALLOW_EXPORT']
async function scenario(config:Record<string,string>,override?:string){
 const saved=keys.map(k=>Deno.env.get(k)),original=fetch;let calls=0;const writes:any[]=[],cache=new Map()
 keys.forEach(k=>Deno.env.delete(k));Deno.env.set('COINMARKETCAP_API_KEY','synthetic-policy-regression');if(override)Deno.env.set('CMC_ALLOW_AI_PROCESSING',override)
 const db={rpc:(name:string,args:any)=>{if(name==='intel_record_market_observations')writes.push(...args.p_rows);return Promise.resolve({data:name==='cmc_account_sync_claim'?{allowed:false,reason:'account_fresh'}:name==='cmc_request_reserve'?{allowed:true,reservation_id:'synthetic'}:true})},from:(table:string)=>{
  let key='',patch:any=null;const q:any={select:()=>q,eq:(f:string,v:string)=>{if(f==='cache_key')key=v;return q},upsert:()=>Promise.resolve({error:null}),update:(v:any)=>{patch=v;return q},insert:()=>Promise.resolve({error:null}),maybeSingle:()=>Promise.resolve({data:table==='provider_quota_budgets'?{config}:cache.get(key)||null}),then:(resolve:any)=>{if(table==='market_data_response_cache'&&patch)cache.set(key,{...cache.get(key),...patch});resolve({error:null})}};return q}}
 globalThis.fetch=async()=>{calls++;return Response.json({status:{error_code:0,credit_count:1},data:[{id:3408,symbol:'USDC',quote:[{id:2781,price:0,last_updated:new Date().toISOString()}]}]})}
 try{
  const first=await requestCmc('listings',{limit:1},{supabase:db,kind:'request',userId:'one',orgId:'org-one',maxCalls:1})
  const next=await requestCmc('listings',{limit:1},{supabase:db,kind:'request',userId:'two',orgId:'org-two',maxCalls:1})
  // The second viewer is served by the snapshot the first one filled: one call
  // for both, and that second read is now named 'cached' rather than 'fresh'.
  eq(first.state,'fresh');eq(next.state,'cached');eq(calls,1)
  const price=writes.find(r=>r.metric==='price');assert(price,'Expected retained public price');return price
 }finally{globalThis.fetch=original;keys.forEach((k,i)=>saved[i]==null?Deno.env.delete(k):Deno.env.set(k,saved[i]!))}
}
const enabled=()=>({CMC_VERIFIED_BASELINE_PLAN:'basic',CMC_ALLOW_AI_PROCESSING:'true',CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_SOURCE_POLICY_EXPIRES_AT:new Date(Date.now()+3600000).toISOString()})
Deno.test('shared CMC refresh records the current database policy and preserves zero across viewers',async()=>{
 const config=enabled(),p=await scenario(config);eq(p.aiAllowed,true);eq(p.value,0);eq(p.exportAllowed,false);eq(p.retainUntil,config.CMC_SOURCE_POLICY_EXPIRES_AT)
})
Deno.test('explicit processing denial wins over the shared policy',async()=>{eq((await scenario(enabled(),'false')).aiAllowed,false)})
Deno.test('expired and missing source policy cannot enable AI processing',async()=>{
 eq((await scenario({...enabled(),CMC_SOURCE_POLICY_EXPIRES_AT:new Date(Date.now()-1000).toISOString()})).aiAllowed,false)
 eq((await scenario({CMC_VERIFIED_BASELINE_PLAN:'basic'})).aiAllowed,false)
})
