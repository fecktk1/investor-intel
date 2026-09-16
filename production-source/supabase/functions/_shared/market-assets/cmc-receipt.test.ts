import assert from 'node:assert/strict'
import { requestCmc } from './cmc-transport.ts'
import { cmcUsable } from './cmc-capabilities.ts'
import { loadAssetHistory } from '../intel/asset-history.ts'

// Self-contained fake of the shared response cache and the accounting RPCs,
// matching the shape cmc.test.ts uses. Only what the receipt paths touch exists.
function fakeDb(options:{cache?:any;reserve?:any}={}) {
  const state={cache:options.cache||null,caches:new Map<string,any>(),rpcs:[] as any[],logs:[] as any[]}
  return {state,rpc:(name:string,args:any)=>{
    state.rpcs.push({name,args})
    return Promise.resolve({data:name==='cmc_account_sync_claim'?{allowed:false,reason:'account_fresh'}:name==='cmc_request_reserve'?(options.reserve||{allowed:true,reservation_id:'test-reservation'}):true})
  },from:(table:string)=>{
    let patch:any=null,key=''
    const q:any={select:()=>q,eq:(field:string,value:string)=>{if(field==='cache_key')key=value;return q},upsert:()=>Promise.resolve({error:null}),
      maybeSingle:()=>Promise.resolve({data:state.caches.get(key)||options.cache||null}),
      update:(v:any)=>{patch=v;return q},insert:(v:any)=>{state.logs.push(v);return Promise.resolve({error:null})},
      then:(resolve:any)=>{if(table==='market_data_response_cache'&&patch){state.cache={...state.caches.get(key),...patch};state.caches.set(key,state.cache)}resolve({error:null})}}
    return q
  }}
}
async function withEnvironment(fn:()=>Promise<void>) {
  const names=['COINMARKETCAP_API_KEY','CMC_API_KEY','CMC_ENABLED','CMC_VERIFIED_BASELINE_PLAN','CMC_ACCESS_PROFILE','CMC_VERIFIED_HACKATHON_PLAN','CMC_HACKATHON_EXPIRES_AT','CMC_CONNECTED_DEMAND_ENABLED'],saved=names.map(n=>Deno.env.get(n)),originalFetch=globalThis.fetch
  Deno.env.set(names[0],'synthetic-cmc-test-key');Deno.env.set('CMC_ENABLED','true');Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','basic')
  Deno.env.delete('CMC_ACCESS_PROFILE');Deno.env.delete('CMC_HACKATHON_EXPIRES_AT');Deno.env.delete('CMC_CONNECTED_DEMAND_ENABLED')
  try{await fn()}finally{globalThis.fetch=originalFetch;names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}
}

Deno.test('a figure served from the shared snapshot reports a cache receipt with its real age',()=>withEnvironment(async()=>{
  globalThis.fetch=()=>{throw new Error('Network must not be called')}
  const cache={response_json:{data:[]},status_code:200,fetched_at:new Date(Date.now()-90000).toISOString(),
    expires_at:new Date(Date.now()+150000).toISOString(),stale_until:new Date(Date.now()+3600000).toISOString()}
  const result=await requestCmc('listings',{},{supabase:fakeDb({cache})})
  assert.equal(result.state,'cached')
  assert.equal(result.receipt?.origin,'cache')
  assert.equal(result.receipt?.capability,'listings')
  assert.equal(result.receipt?.endpoint,'/v3/cryptocurrency/listings/latest')
  assert.deepEqual(result.receipt?.parameters,{limit:'100',start:'1'})
  // The ORIGINATING call's status, not the status of this (call-free) read.
  assert.equal(result.receipt?.httpStatus,200)
  assert.equal(result.receipt?.ttlSeconds,240)
  assert.ok(result.receipt!.cacheAgeSeconds!>=89&&result.receipt!.cacheAgeSeconds!<=93,`age was ${result.receipt!.cacheAgeSeconds}`)
  // The cache row does not retain the originating charge, and estimateCmcCredits
  // is a floor rather than a charge, so a cache hit must report no credit at all.
  assert.equal(result.receipt?.creditCount,null)
  assert.equal(result.receipt?.keyMode,'keyed')
}))
Deno.test('a reported charge of zero is carried as zero, never as unknown',()=>withEnvironment(async()=>{
  globalThis.fetch=async()=>Response.json({data:[{id:1}],status:{error_code:0,credit_count:0}})
  const result=await requestCmc('listings',{},{supabase:fakeDb(),kind:'request'})
  assert.equal(result.state,'fresh')
  assert.equal(result.receipt?.origin,'live')
  assert.equal(result.receipt?.creditCount,0)
  assert.equal(result.receipt?.httpStatus,200)
  assert.equal(result.receipt?.cacheAgeSeconds,0)
  assert.equal(result.receipt?.reservation,'test-reservation')
  assert.ok((result.receipt?.elapsedMs??-1)>=0)
}))
Deno.test('a quote basket answered entirely from the snapshot is cached rather than stale',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[{id:1},{id:1027}],status:{error_code:0,credit_count:1}})}
  const db=fakeDb(),ctx={supabase:db,kind:'request' as const}
  const live=await requestCmc('quotes',{id:'1,1027'},ctx)
  assert.equal(live.state,'fresh');assert.equal(live.receipt?.origin,'live')
  const later=await requestCmc('quotes',{id:'1,1027'},ctx)
  assert.equal(later.state,'cached');assert.equal(later.receipt?.origin,'cache')
  assert.equal(calls,1)
}))
Deno.test('a consumer that accepted only a live read still succeeds on a cached one',async()=>{
  assert.equal(cmcUsable('fresh'),true);assert.equal(cmcUsable('cached'),true)
  assert.equal(cmcUsable('stale'),false);assert.equal(cmcUsable('refreshing'),false);assert.equal(cmcUsable(undefined),false)
  const NOW=Date.parse('2026-09-14T12:00:00Z'),DAY=86400000
  const point=(t:number)=>({timestamp:new Date(t).toISOString(),quote:{USD:{price:100,volume_24h:1,market_cap:2,timestamp:new Date(t).toISOString()}}})
  const payload={data:{'1027':{id:1027,quotes:[point(NOW-DAY),point(NOW)]}},status:{error_code:0}}
  const provenance={provider:'coinmarketcap' as const,observedAt:null,fetchedAt:'2026-09-14T11:59:00.000Z',expiresAt:null,sourceUrl:''}
  // Before 'cached' existed this consumer saw a cache hit as 'fresh'. It must keep
  // treating that same snapshot as a usable series now that it is named honestly.
  for(const state of ['fresh','cached'] as const){
    const history=await loadAssetHistory({} as any,{cmcId:'1027',range:'90d',now:NOW,
      request:(()=>Promise.resolve({payload,state,reason:null,provenance,receipt:null})) as any})
    assert.equal(history.state,'fresh',`a '${state}' read must remain a usable history read`)
    assert.equal(history.points.length,2)
  }
})
