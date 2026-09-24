import assert from 'node:assert/strict'
import { requestCmc } from './cmc-transport.ts'

// ctx.refreshBefore (types.ts): a read that may call can declare a shared copy
// fetched before that instant past its window, so the ONE refresh it is allowed
// actually happens. The fake reservation refuses a copy still inside its window
// ('cache_ready'), exactly as cmc_request_reserve does, so the test fails unless
// the transport shortened the copy's expiry before reserving.
function fakeDb(initial:any) {
  const state={caches:new Map<string,any>(),rpcs:[] as any[],updates:[] as any[]}
  let seeded=false
  const row=(key:string)=>{if(!seeded&&initial){state.caches.set(key,{...initial});seeded=true}return state.caches.get(key)??null}
  return {state,rpc:(name:string,args:any)=>{
    state.rpcs.push({name,args})
    if(name==='cmc_account_sync_claim')return Promise.resolve({data:{allowed:false,reason:'account_fresh'},error:null})
    if(name==='cmc_request_reserve'){
      const r=row(args.p_cache_key)
      if(r?.response_json!=null&&Date.parse(r.expires_at)>Date.now())return Promise.resolve({data:{allowed:false,reason:'cache_ready'},error:null})
      return Promise.resolve({data:{allowed:true,reservation_id:'reservation-1'},error:null})
    }
    return Promise.resolve({data:true,error:null})
  },from:(table:string)=>{
    let patch:any=null,key='';const filters:Record<string,unknown>={}
    const q:any={select:()=>q,eq:(field:string,value:string)=>{if(field==='cache_key')key=value;filters[field]=value;return q},
      upsert:()=>Promise.resolve({error:null}),insert:()=>Promise.resolve({error:null}),
      maybeSingle:()=>Promise.resolve({data:table==='market_data_response_cache'?row(key):null,error:null}),
      update:(v:any)=>{patch=v;return q},
      then:(resolve:any)=>{
        if(table==='market_data_response_cache'&&patch){
          const current=row(key)
          // Compare-and-set: every filter must still hold on the stored row.
          const holds=Object.entries(filters).every(([f,v])=>f==='provider'||f==='cache_key'||f==='refresh_token'||String(current?.[f])===String(v))
          if(holds&&current){state.caches.set(key,{...current,...patch});state.updates.push(patch)}
        }
        resolve({error:null})
      }}
    return q
  }}
}
async function withEnvironment(fn:()=>Promise<void>) {
  const names=['COINMARKETCAP_API_KEY','CMC_API_KEY','CMC_ENABLED','CMC_VERIFIED_BASELINE_PLAN','CMC_ACCESS_PROFILE','CMC_VERIFIED_HACKATHON_PLAN','CMC_HACKATHON_EXPIRES_AT','CMC_CONNECTED_DEMAND_ENABLED'],saved=names.map(n=>Deno.env.get(n)),originalFetch=globalThis.fetch
  Deno.env.set(names[0],'synthetic-cmc-test-key');Deno.env.set('CMC_ENABLED','true');Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','basic')
  Deno.env.delete('CMC_ACCESS_PROFILE');Deno.env.delete('CMC_HACKATHON_EXPIRES_AT');Deno.env.delete('CMC_CONNECTED_DEMAND_ENABLED')
  try{await fn()}finally{globalThis.fetch=originalFetch;names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}
}
const body=(updated:string)=>({status:{error_code:0,credit_count:1,timestamp:new Date().toISOString()},data:{rwa_assets:[{rwa_id:2,symbol:'NVDA',quotes:[{symbol:'USD',last_updated:updated,average_tokenized_price:226}]}]}})
const copy=(minutesOld:number)=>({response_json:body('2026-09-24T01:00:00.000Z'),status_code:200,fetched_at:new Date(Date.now()-minutesOld*60_000).toISOString(),
  expires_at:new Date(Date.now()+(60-minutesOld)*60_000).toISOString(),stale_until:new Date(Date.now()+(360-minutesOld)*60_000).toISOString()})
const live=(db:any,refreshBefore:string|null)=>requestCmc('rwaQuotes',{rwa_id:2},{supabase:db,kind:'request',maxCalls:1,waitForFresh:true,noDemand:true,selectedDemand:false,caller:'intel-rwa-lookup-live',refreshBefore} as any)

Deno.test('refreshBefore: a copy fetched before it is refreshed by exactly one live call',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(body('2026-09-24T01:59:00.000Z'))}
  const db=fakeDb(copy(20))
  const out=await live(db,new Date(Date.now()-10*60_000).toISOString())
  assert.equal(calls,1)
  assert.equal(out.state,'fresh');assert.equal(out.receipt?.origin,'live');assert.equal(out.receipt?.creditCount,1)
  // The copy's expiry was moved to now first (that is what the reservation needed).
  assert.ok(db.state.updates.some((u:any)=>Object.keys(u).length===1&&u.expires_at),'expiry shortened before the call')
  assert.ok(db.state.rpcs.some((r:any)=>r.name==='cmc_request_reserve'))
}))

Deno.test('refreshBefore: without it, or with a copy newer than it, an in-window copy answers and nothing is called',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(body('2026-09-24T01:59:00.000Z'))}
  const none=await live(fakeDb(copy(20)),null)
  assert.equal(none.state,'cached');assert.equal(none.receipt?.origin,'cache')
  const newer=await live(fakeDb(copy(5)),new Date(Date.now()-10*60_000).toISOString())
  assert.equal(newer.state,'cached')
  assert.equal(calls,0)
}))

Deno.test('refreshBefore: a render read (the cache-only pass) never shortens anything and never calls',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(body('2026-09-24T01:59:00.000Z'))}
  const db=fakeDb(copy(20))
  const out=await requestCmc('rwaQuotes',{rwa_id:2},{supabase:db,kind:'render',maxCalls:0,refreshBefore:new Date().toISOString()} as any)
  assert.equal(out.state,'cached');assert.equal(calls,0)
  assert.equal(db.state.updates.length,0)
}))
