import { hasVerifiedCexIdentity } from '../intel/market-read-quality.ts'
import assert from 'node:assert/strict'
import { cmcParams, cmcRows, cmcRequestBody, estimateCmcCredits, cmcObservedAt } from './cmc-capabilities.ts'
import { requestCmc, cmcPlan, cmcCreditCeiling } from './cmc-transport.ts'
import { planCmcRefresh, refreshCmcDemand } from './cmc-refresh-planner.ts'
import { assembleTokenUnlockState } from '../intel/market-enrichment.ts'
import { cmcAssetFacts, cmcDeployments, fetchCoinmarketcapTopAssets, mapCmcListing, sha256Hex } from './coinmarketcap-provider.ts'
import { marketCanonicalIdentity, marketIdentityChoices, marketChain, usableSpread } from '../intel/market-read-quality.ts'
import { researchParams, requireIntelAccess, researchSnapshot } from '../intel/research-service.ts'
import { cmcAssetRow, resolveCmcAsset } from '../intel/cmc-asset-identity.ts'

Deno.test('Missing canonical CMC assets resolve exact IDs with original timestamp and contract identity',async()=>{
  const quote={data:[{id:123,symbol:'DUP',quote:[{id:2781,price:20,last_updated:'2026-09-09T12:00:00Z'}]}]},metadata={data:{123:{id:123,symbol:'DUP',name:'Correct asset',platform:{slug:'arbitrum',token_address:'0x'+'a'.repeat(40)}}}}
  const row=cmcAssetRow('123',quote,metadata)
  assert.equal(row?.name,'Correct asset');assert.equal(row?.as_of,'2026-09-09T12:00:00.000Z')
  assert.equal(marketCanonicalIdentity(row).canonicalAssetKey,'eip155:42161:0x'+'a'.repeat(40))
  assert.equal(cmcAssetRow('999',quote,metadata),null)
  assert.equal(cmcAssetRow('123',null,metadata)?.current_price,null)
  const calls:any[]=[]
  const result=await resolveCmcAsset({},'123',(async(name:string,params:any)=>{calls.push([name,params]);return {payload:name==='quotes'?quote:metadata,state:'fresh'}}) as any)
  assert.equal(result.data?.provider_id,'123');assert.deepEqual(calls,[['quotes',{id:'123'}],['metadata',{id:'123'}]])
  await resolveCmcAsset({},'DUP',(async()=>{throw Error('No symbol fetch')}) as any)
})

Deno.test('CMC v3 quotes normalize USD arrays and preserve the provider observation',()=>{
  const row={id:1,symbol:'BTC',last_updated:'2026-09-09T12:00:00Z',quote:[{id:2781,price:100,market_cap:1000,last_updated:'2026-09-09T11:59:00Z'}]}
  assert.equal(cmcRows('quotes',{data:[row]}).rows[0].quote.price,100)
  assert.equal(mapCmcListing(row)?.asOf,Date.parse('2026-09-09T11:59:00Z'))
  assert.equal(mapCmcListing({...row,last_updated:null,quote:[]}),null)
  // Listings already carry the tradeable-pair count; nothing else supplies it.
  assert.equal(mapCmcListing({...row,num_market_pairs:412})?.numMarketPairs,412)
  assert.equal(mapCmcListing(row)?.numMarketPairs,null)
  assert.equal(mapCmcListing({...row,num_market_pairs:'not a number'})?.numMarketPairs,null)
  assert.equal(cmcObservedAt({data:[row],status:{timestamp:'2026-09-09T13:00:00Z'}}),'2026-09-09T11:59:00.000Z')
})
Deno.test('CMC v5 nested rows, totals and issuer identity remain distinct',()=>{
  assert.deepEqual(cmcRows('rwaList',{data:{rwa_assets:[{rwa_id:8,average_tokenized_price:4}],total_size:50,has_more:true}}),{rows:[{rwa_id:8,average_tokenized_price:4,quote:{}}],total:50,hasMore:true})
  assert.equal(cmcRows('derivativeExchanges',{data:{exchanges:[{exchange_id:1,open_interest:5}]}}).rows[0].open_interest,5)
  assert.equal(cmcRows('derivativeExchanges',{data:{exchanges:[{exchange_id:1,quotes:[{convert_id:2781,convert_symbol:'USD',open_interest:8,derivative_volume:9}]}]}}).rows[0].quote.derivative_volume,9)
  assert.equal(cmcRows('derivativePairs',{data:{market_pairs:[{quotes:[{symbol:'USD',open_interest:9}],exchange_reported_quotes:[{symbol:'USD',funding_rate:0.01}]}]}}).rows[0].exchangeReportedQuote.funding_rate,0.01)
  assert.throws(()=>cmcParams('issuer',{issuer_id:'BTC'}),/invalid_identifier/)
})
Deno.test('CMC request bounds and family-specific costs reject accidental fan-out',()=>{
  assert.equal(estimateCmcCredits('quotes',cmcParams('quotes',{id:Array.from({length:250},(_,i)=>i+1).join(',')})),1)
  assert.equal(estimateCmcCredits('history',cmcParams('history',{id:1,count:100})),1)
  assert.equal(estimateCmcCredits('categories',cmcParams('categories',{limit:250})),3)
  assert.equal(estimateCmcCredits('rwaMap',cmcParams('rwaMap')),0)
  assert.equal(estimateCmcCredits('map',cmcParams('map')),0)
  assert.equal(cmcRows('performance',{data:{1:{id:1,periods:{all_time:{}}}}}).rows[0].id,1)
  assert.throws(()=>cmcParams('quotes',{id:1,symbol:'BTC'}),/multiple_identifier/)
  assert.throws(()=>cmcParams('history',{id:1,interval:'weekly'}),/daily/)
  assert.throws(()=>researchParams('quotes',{id:Array.from({length:21},(_,i)=>i+1).join(',')}),/maximum_identifiers/)
  assert.throws(()=>researchParams('listings',{limit:101}),/maximum_rows/)
  assert.throws(()=>cmcParams('listings',{url:'https://example.com'}),/invalid_parameter/)
})
Deno.test('Markets resolve platform aliases and ledger identity without symbol guessing',()=>{
  assert.equal(marketChain('arbitrum-one'),'arbitrum')
  assert.equal(marketCanonicalIdentity({source_provider:'coinmarketcap',provider_id:'1027',symbol:'WRONG'}).canonicalAssetKey,'eip155:1:native')
  assert.equal(marketCanonicalIdentity({symbol:'ETH'}).canonicalAssetKey,null)
  assert.equal(marketCanonicalIdentity({platforms:{'arbitrum-one':'0x'+'a'.repeat(40)}}).canonicalAssetKey,'eip155:42161:0x'+'a'.repeat(40))
  assert.equal(marketCanonicalIdentity({platforms:{ethereum:'0x'+'a'.repeat(40),base:'0x'+'b'.repeat(40)}}).identityState,'chain_selection_required')
})
Deno.test('Spreads suppress stale, ambiguous quality and invalid venues',()=>{
  const now=Date.now(),r={as_of:new Date(now).toISOString(),confidence_score:75,lowest_ask_price:1,highest_bid_price:2,buy_provider:'a',sell_provider:'b',estimated_net_spread_pct:1,caution_flags:[]}
  assert.equal(usableSpread(r,now),true)
  assert.equal(usableSpread({...r,as_of:new Date(now-181000).toISOString()},now),false)
  assert.equal(usableSpread({...r,buy_provider:'b'},now),false)
  assert.equal(usableSpread({...r,caution_flags:['quote normalization assumed (USD-stable 1:1)']},now),false)
})

function fakeDb(options:{cache?:any;reserve?:any;fail?:boolean}={}) {
  const state={cache:options.cache||null,caches:new Map<string,any>(),rpcs:[] as any[],logs:[] as any[]}
  return {state,rpc:(name:string,args:any)=>{
    state.rpcs.push({name,args})
    if(options.fail)return Promise.resolve({error:{message:'private DB error'}})
    return Promise.resolve({data:name==='cmc_account_sync_claim'?{allowed:false,reason:'account_fresh'}:name==='cmc_request_reserve'?(options.reserve||{allowed:true,reservation_id:'test-reservation'}):true})
  },from:(table:string)=>{
    let patch:any=null,key=''
    const q:any={select:()=>q,eq:(field:string,value:string)=>{if(field==='cache_key')key=value;return q},upsert:()=>Promise.resolve({error:null}),maybeSingle:()=>Promise.resolve({data:state.caches.get(key)||options.cache||null}),update:(v:any)=>{patch=v;return q},insert:(v:any)=>{state.logs.push(v);return Promise.resolve({error:null})},then:(resolve:any)=>{if(table==='market_data_response_cache'&&patch){state.cache={...state.caches.get(key),...patch};state.caches.set(key,state.cache)}resolve({error:null})}}
    return q
  }}
}
async function withEnvironment(fn:()=>Promise<void>) {
  const names=['COINMARKETCAP_API_KEY','CMC_API_KEY','CMC_ENABLED','CMC_VERIFIED_BASELINE_PLAN','CMC_ACCESS_PROFILE','CMC_VERIFIED_HACKATHON_PLAN','CMC_HACKATHON_EXPIRES_AT','CMC_CONNECTED_DEMAND_ENABLED'],saved=names.map(n=>Deno.env.get(n)),originalFetch=globalThis.fetch
  Deno.env.set(names[0],'synthetic-cmc-test-key');Deno.env.set('CMC_ENABLED','true');Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','basic');Deno.env.delete('CMC_ACCESS_PROFILE');Deno.env.delete('CMC_HACKATHON_EXPIRES_AT')
  Deno.env.delete('CMC_CONNECTED_DEMAND_ENABLED')
  try{await fn()}finally{globalThis.fetch=originalFetch;names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}
}
Deno.test('exchange disclosures send only the documented ID and share one snapshot across pages',()=>withEnvironment(async()=>{
 const urls:string[]=[];globalThis.fetch=async(input)=>{urls.push(String(input));return Response.json({status:{error_code:0,credit_count:1},data:[]})}
 const db=fakeDb()
 const first=await requestCmc('exchangeAssets',{id:'270'},{supabase:db,kind:'request',maxCalls:1})
 const second=await requestCmc('exchangeAssets',{id:'270'},{supabase:db,kind:'request',maxCalls:1})
 assert.equal(first.state,'fresh');assert.equal(second.state,'fresh');assert.equal(urls.length,1)
 assert.equal(new URL(urls[0]).search,'?id=270');assert.equal(first.provenance.observedAt,null)
}))
Deno.test('100 asset selections across users reuse one full exchange response and keep selection out of the provider URL',()=>withEnvironment(async()=>{
 const urls:string[]=[];globalThis.fetch=async(input)=>{urls.push(String(input));await new Promise(r=>setTimeout(r,5));return Response.json({status:{error_code:0,credit_count:1},data:Array.from({length:30},(_,i)=>({wallet_address:`wallet-${i}`,balance:i,platform:{crypto_id:1},currency:{crypto_id:i+1,name:'Same name',symbol:'SAME',price_usd:10}}))})}
 const db=fakeDb(),results=await Promise.all(Array.from({length:100},(_,i)=>researchSnapshot(db,'exchangeAssets',{id:'270'},`user-${i}`,`org-${i%5}`,{start:i%2?13:1,limit:12,assetId:String(i%30+1)})))
 assert.equal(urls.length,1);assert.equal(new URL(urls[0]).search,'?id=270');assert.equal(db.state.caches.size,1)
 assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reserve').length,1)
 results.forEach((r,i)=>{assert.ok('selectedAsset' in r.data && r.data.selectedAsset?.asset);assert.equal(r.data.selectedAsset.asset.id,String(i%30+1));assert.equal(r.data.selectedAsset.asset.quantity,i%30);assert.equal(r.data.rows.length,12)})
 assert.equal(new Set(results.map(r=>{assert.ok('sourceReference' in r.data);return r.data.sourceReference.payloadHash})).size,1)
 assert.ok(!JSON.stringify(results).includes('user-'));assert.ok(!JSON.stringify(results).includes('org-'))
}))
Deno.test('100 selected-view retained reads record shared demand but cannot reserve credits or call a provider',()=>withEnvironment(async()=>{
 Deno.env.set('CMC_CONNECTED_DEMAND_ENABLED','true');Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','startup')
 let network=0;globalThis.fetch=()=>{network++;throw Error('No provider read permitted')}
 const db=fakeDb()
 const results=await Promise.all(Array.from({length:100},(_,i)=>requestCmc('dexToken',{platform:'ethereum',address:'0x'+'a'.repeat(40)},
  {supabase:db,kind:'render',selectedDemand:true,maxCalls:0,userId:`user-${i}`,orgId:`org-${i%5}`})))
 assert.ok(results.every(r=>r.reason==='refresh_required'));assert.equal(network,0)
 assert.equal(db.state.rpcs.length,0);assert.equal(db.state.caches.size,1)
 assert.equal(db.state.cache.capability,'dexToken');assert.ok(Date.parse(db.state.cache.demanded_at)>0)
 const off=fakeDb();Deno.env.set('CMC_CONNECTED_DEMAND_ENABLED','false')
 await requestCmc('dexToken',{platform:'ethereum',address:'0x'+'a'.repeat(40)},{supabase:off,kind:'render',selectedDemand:true,maxCalls:0,userId:'user',orgId:'org'})
 assert.equal(off.state.caches.size,0)
}))
Deno.test('governed DEX POST callers share one typed request and reject arbitrary payloads before fetch',()=>withEnvironment(async()=>{
 Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','startup')
 const calls:any[]=[];globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});await new Promise(r=>setTimeout(r,5));return Response.json({status:{error_code:'0',credit_count:1},data:{leaderboardList:[],total:'0'}})}
 const db=fakeDb(),results=await Promise.all(Array.from({length:20},(_,i)=>requestCmc('dexTrending',{platformIds:199,pageSize:12},{supabase:db,kind:'request',orgId:`o-${i}`,userId:`u-${i}`,maxCalls:1})))
 assert.equal(calls.length,1);assert(results.every(r=>r.state==='fresh'));assert.equal(calls[0].url,'https://pro-api.coinmarketcap.com/v1/dex/tokens/trending/list')
 assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{interval:'24h',pageSize:12,platformIds:'199'})
 await assert.rejects(()=>requestCmc('dexTrending',{filter:{maker:'private'}},{supabase:db}),/invalid_parameter/);assert.equal(calls.length,1)
 assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reconcile').length,1)
}))
Deno.test('an upstream rejected request is a failure rather than missing market coverage',()=>withEnvironment(async()=>{
 globalThis.fetch=async()=>Response.json({status:{error_code:400,error_message:'Invalid query parameter',credit_count:0}},{status:400})
 const r=await requestCmc('exchangeAssets',{id:'89'},{supabase:fakeDb(),kind:'request',maxCalls:1})
 assert.equal(r.payload,null);assert.equal(r.state,'unavailable');assert.equal(r.reason,'provider_request_rejected')
}))
Deno.test('research waits for a shared refresh even in an Edge background runtime',()=>withEnvironment(async()=>{
  const runtime=(globalThis as any).EdgeRuntime
  let deferred=0,calls=0
  ;(globalThis as any).EdgeRuntime={waitUntil:()=>{deferred++}}
  const db=fakeDb({cache:{response_json:{data:[{id:2,quote:{USD:{price:1}}}]},fetched_at:new Date(Date.now()-600000).toISOString(),expires_at:new Date(Date.now()-1000).toISOString(),stale_until:new Date(Date.now()+600000).toISOString()}})
  globalThis.fetch=()=>{calls++;return Promise.resolve(new Response(JSON.stringify({status:{error_code:0,credit_count:1},data:[{id:2,quote:{USD:{price:2}}}]}),{status:200}))}
  try {
    const result=await requestCmc('quotes',{id:'2'},{supabase:db,waitForFresh:true,maxCalls:1})
    assert.equal(result.state,'fresh');assert.equal(cmcRows('quotes',result.payload).rows[0].quote.price,2);assert.equal(calls,1);assert.equal(deferred,0)
  }finally{(globalThis as any).EdgeRuntime=runtime}
}))
Deno.test('concurrent cold readers await the shared snapshot without another provider call',()=>withEnvironment(async()=>{
  let network=0
  globalThis.fetch=()=>{network++;throw new Error('No second provider call')}
  const db=fakeDb({reserve:{allowed:false,reason:'refreshing'}})
  const timer=setTimeout(()=>db.state.caches.set([...db.state.rpcs].find(r=>r.name==='cmc_request_reserve')!.args.p_cache_key,{response_json:{data:[{id:1}]},expires_at:new Date(Date.now()+60000).toISOString(),stale_until:new Date(Date.now()+60000).toISOString()}),75)
  try{const result=await requestCmc('listings',{limit:10},{supabase:db,kind:'request'});assert.equal(result.state,'fresh');assert.equal(result.payload.data[0].id,1);assert.equal(network,0);assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reserve').length,1)}finally{clearTimeout(timer)}
}))
Deno.test('CMC cache hits, render, entitlement and database failure spend zero calls',()=>withEnvironment(async()=>{
  globalThis.fetch=()=>{throw new Error('Network must not be called')}
  const cache={response_json:{data:[]},expires_at:new Date(Date.now()+60000).toISOString(),stale_until:new Date(Date.now()+60000).toISOString()}
  const db=fakeDb({cache});assert.equal((await requestCmc('listings',{}, {supabase:db})).state,'fresh');assert.equal(db.state.rpcs.length,0)
  assert.equal((await requestCmc('listings',{}, {supabase:fakeDb(),kind:'render'})).reason,'refresh_required')
  assert.equal((await requestCmc('listings',{}, {supabase:fakeDb({fail:true})})).reason,'accounting_unavailable')
  assert.equal((await requestCmc('content',{}, {supabase:fakeDb()})).state,'unsupported')
  assert.equal((await requestCmc('listings',{}, {supabase:fakeDb({reserve:{allowed:false,reason:'budget_exceeded'}})})).reason,'budget_exceeded')
}))
Deno.test('CMC concurrent consumers share one call and reconcile actual credit_count',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json({data:[{id:1,quote:[{id:2781,price:100}]}],status:{error_code:0,credit_count:2}})}
  const db=fakeDb(),ctx={supabase:db,kind:'request' as const}
  const results=await Promise.all([requestCmc('quotes',{id:1},ctx),requestCmc('quotes',{id:1},ctx)])
  assert.equal(calls,1);assert.equal(results[0].state,'fresh')
  assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reconcile').length,1)
  assert.equal(db.state.rpcs.find(r=>r.name==='cmc_request_reconcile').args.p_actual,2)
}))
Deno.test('100 users across organizations share one batch and later readers use the durable cache',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json({data:[{id:1},{id:1027}],status:{error_code:0,credit_count:1}})}
  const db=fakeDb()
  const responses=await Promise.all(Array.from({length:100},(_,i)=>requestCmc('quotes',{id:i%2?'01027,1,1':'1,1027'},{supabase:db,kind:'request',orgId:`org-${i%10}`,userId:`user-${i}`})))
  assert.equal(calls,1);assert.ok(responses.every(r=>r.state==='fresh'))
  assert.equal(db.state.caches.size,1)
  assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reserve').length,1)
  assert.equal(db.state.rpcs.filter(r=>r.name==='cmc_request_reconcile').length,1)
  const later=await requestCmc('quotes',{id:'1027,1'},{supabase:db,kind:'request',orgId:'different-org',userId:'another-user'})
  assert.equal(later.state,'fresh');assert.equal(calls,1)
  assert.ok(!JSON.stringify(later).includes('user-'))
  assert.ok(!JSON.stringify(later).includes('org-'))
}))
Deno.test('Equivalent identifiers and timezones normalize without collapsing different asset requests',()=>{
  assert.deepEqual(cmcParams('quotes',{slug:'Ethereum,bitcoin,Bitcoin'}),cmcParams('quotes',{slug:'bitcoin,ethereum'}))
  assert.deepEqual(cmcParams('history',{id:1,time_start:'2026-09-08T07:00:00-05:00',time_end:'2026-09-09T12:00:00Z'}),cmcParams('history',{id:1,time_start:'2026-09-08T12:00:00.000Z',time_end:'2026-09-09T12:00:00.000Z'}))
  assert.notDeepEqual(cmcParams('quotes',{id:1}),cmcParams('quotes',{id:1027}))
  assert.throws(()=>cmcParams('quotes',{id:'9007199254740993'}),/invalid_identifier/)
  assert.throws(()=>cmcParams('quotes',{id:'0'}),/invalid_identifier/)
})
Deno.test('BTC and ETH viewed separately across users share a single CMC request, without response cross-contamination',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json({data:[{id:1},{id:1027}],status:{error_code:0,credit_count:1}})}
  const db=fakeDb()
  const results=await Promise.all(Array.from({length:100},(_,i)=>requestCmc('quotes',{id:i%2?'1027':'1'},{supabase:db,kind:'request',orgId:`org-${i}`,userId:`user-${i}`})))
  assert.equal(calls,1);results.forEach((r,i)=>assert.deepEqual(r.payload.data.map((x:any)=>x.id),[i%2?1027:1]))
  assert.equal(db.state.caches.size,1)
  const ttl=Date.parse(db.state.cache.expires_at)-Date.parse(db.state.cache.fetched_at)
  assert.ok(ttl>=60000&&ttl<60100)
}))
Deno.test('CMC HTTP denial and network failure do not retry and reconcile conservatively',()=>withEnvironment(async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({status:{error_code:1006,credit_count:0}},{status:403})}
  const db=fakeDb();assert.equal((await requestCmc('quotes',{id:1},{supabase:db})).reason,'insufficient_entitlement');assert.equal(calls,1)
  assert.equal(db.state.rpcs.find(r=>r.name==='cmc_request_reconcile').args.p_actual,0)
  globalThis.fetch=()=>{throw new Error('synthetic transport error')}
  const broken=fakeDb();assert.equal((await requestCmc('quotes',{id:2},{supabase:broken})).state,'unavailable')
  assert.equal(broken.state.rpcs.find(r=>r.name==='cmc_request_reconcile').args.p_actual,null)
}))
Deno.test('Hackathon profile automatically returns to verified baseline after expiry',()=>withEnvironment(async()=>{
  Deno.env.set('CMC_ACCESS_PROFILE','hackathon');Deno.env.set('CMC_VERIFIED_HACKATHON_PLAN','startup')
  assert.equal(cmcPlan(Date.parse('2026-09-20T00:00:00Z')),'startup')
  assert.equal(cmcPlan(Date.parse('2026-10-01T00:00:00Z')),'basic')
  Deno.env.set('CMC_HACKATHON_EXPIRES_AT','not-a-date')
  assert.equal(cmcPlan(Date.parse('2026-09-20T00:00:00Z')),'basic')
  Deno.env.set('CMC_VERIFIED_BASELINE_PLAN','startup');Deno.env.delete('CMC_ACCESS_PROFILE')
  assert.equal(cmcCreditCeiling(),360000)
}))

Deno.test('Demand planner bounds shared due keys and requires recent active access',async()=>{
  const now=Date.now(),base={capability:'quotes',access_profile:'basic',demand_org_id:'org',demand_user_id:'user',demanded_at:new Date(now).toISOString(),expires_at:new Date(now-1000).toISOString()}
  const rows=[{...base,cache_key:'one'},{...base,cache_key:'one'},{...base,cache_key:'two'},{...base,cache_key:'three'},{...base,cache_key:'inactive',demanded_at:new Date(now-31*60000).toISOString()},{...base,cache_key:'unverified',demanded_at:null}]
  assert.deepEqual(planCmcRefresh(rows,'basic',now).map(r=>r.cache_key),['one','two','three'])
  assert.equal(planCmcRefresh(Array.from({length:40},(_,i)=>({...base,cache_key:`batch-${i}`})),'basic',now).length,8)
  assert.deepEqual(planCmcRefresh(rows,'startup',now),[])
  const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No calls for expired access')}
  const db={rpc:()=>Promise.resolve({data:false}),from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,in:()=>q,gte:()=>q,lte:()=>q,order:()=>q,limit:()=>q,maybeSingle:()=>Promise.resolve({data:{org_id:'org'}}),then:(resolve:any)=>resolve({data:table==='market_data_response_cache'?rows:[]})};return q}}
  try{assert.equal(await refreshCmcDemand(db,now),'idle')}finally{globalThis.fetch=original}
})
Deno.test('Cached-only unlock evidence cannot warm Mobula when cache is missing',async()=>{
  const original=globalThis.fetch,oldKey=Deno.env.get('MOBULA_API_KEY');let calls=0
  Deno.env.set('MOBULA_API_KEY','synthetic-unlock-key')
  globalThis.fetch=()=>{calls++;throw new Error('Cached-only evidence attempted a provider call')}
  const db={from:()=>{const q:any={select:()=>q,eq:()=>q,gte:()=>q,order:()=>q,limit:()=>Promise.resolve({data:[]})};return q}}
  try{assert.equal((await assembleTokenUnlockState(db,{symbol:'BTC',nowMs:Date.now(),allowLive:false})).status,'missing');assert.equal(calls,0)}finally{globalThis.fetch=original;oldKey==null?Deno.env.delete('MOBULA_API_KEY'):Deno.env.set('MOBULA_API_KEY',oldKey)}
})

Deno.test('Research authorizes membership before existing paid, trial or holder access resolver',async()=>{
  const names=['SUPABASE_URL','SUPABASE_ANON_KEY'],saved=names.map(n=>Deno.env.get(n))
  Deno.env.set(names[0],'https://synthetic.invalid');Deno.env.set(names[1],'synthetic-anon')
  const req=new Request('https://example.invalid',{headers:{Authorization:'Bearer synthetic-user'}})
  const client=()=>({auth:{getUser:()=>Promise.resolve({data:{user:{id:'member'}}})}})
  let member=true,access=true,accessError=false,rpcCalls=0
  const db={from:(table:string)=>{const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:table==='org_members'&&member?{org_id:'org'}:null})};return q},rpc:(name:string,args:any)=>{rpcCalls++;assert.equal(name,'can_access_intel');assert.deepEqual(args,{p_user:'member',p_org:'org'});return Promise.resolve({data:access,error:accessError?{}:null})}}
  try{
    assert.equal((await requireIntelAccess(req,client,db,'org')).userId,'member')
    member=false;await assert.rejects(()=>requireIntelAccess(req,client,db,'other'),(e:any)=>e.status===403);assert.equal(rpcCalls,1)
    member=true;access=false;await assert.rejects(()=>requireIntelAccess(req,client,db,'org'),(e:any)=>e.status===403)
    accessError=true;await assert.rejects(()=>requireIntelAccess(req,client,db,'org'),(e:any)=>e.status===503)
    await assert.rejects(()=>requireIntelAccess(new Request('https://example.invalid'),client,db,'org'),(e:any)=>e.status===401)
  }finally{names.forEach((n,i)=>saved[i]==null?Deno.env.delete(n):Deno.env.set(n,saved[i]!))}
})
Deno.test('RWA market observation uses quote clocks and excludes old metadata and status time',()=>{
 const body={status:{timestamp:'2026-09-10T22:57:52Z'},data:{rwa_assets:[{name:'Unpriced older listing',last_updated:'2026-05-18T15:21:16Z',quotes:[{symbol:'USD',average_tokenized_price:null,last_updated:'2026-09-10T22:56:04Z'}]},{name:'Gold',last_updated:'2026-09-10T22:56:38Z',quotes:[{symbol:'USD',average_tokenized_price:4320,last_updated:'2026-09-10T22:56:04Z'}]}]}}
 assert.equal(cmcObservedAt(body,'rwaList'),'2026-09-10T22:56:04.000Z')
 assert.equal(cmcObservedAt({data:{rwa_assets:[{last_updated:'2026-09-10T22:56:38Z',quotes:[]}]}},'rwaQuotes'),null)
 assert.equal(cmcObservedAt({data:{rwa_assets:[{quotes:[{symbol:'USD',last_updated:'2099-01-01T00:00:00Z'}]}]}},'rwaQuotes'),null)
})
Deno.test('CMC venue market pairs retain parent venue identity, real pair symbols and pagination totals',()=>{
 const result=cmcRows('exchangeDerivativePairs',{data:{exchange_id:270,exchange_name:'Binance',exchange_slug:'binance',num_market_pairs:796,market_pairs:[{market_id:47150,market_pair_symbol:'BTC/USDT',quotes:[{convert_id:2781,price:76811,open_interest:8250989166}]}]}})
 assert.equal(result.total,796);assert.equal(result.rows[0].market_pair_symbol,'BTC/USDT');assert.equal(result.rows[0].exchange.exchange_id,270);assert.equal(result.rows[0].exchange.name,'Binance');assert.equal(result.rows[0].quote.open_interest,8250989166)
})

Deno.test('shorter derivative policy refreshes an older fifteen-minute cache once across readers',()=>withEnvironment(async()=>{
 let calls=0;const now=Date.now(),cache={response_json:{data:{market_pairs:[{market_id:1}]}},fetched_at:new Date(now-180000).toISOString(),expires_at:new Date(now+720000).toISOString(),stale_until:new Date(now+3600000).toISOString()}
 const db=fakeDb({cache});globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,5));return Response.json({status:{error_code:0,credit_count:1},data:{market_pairs:[{market_id:2}]}})}
 const results=await Promise.all(Array.from({length:20},()=>requestCmc('derivativePairs',{crypto_id:1},{supabase:db,kind:'request',waitForFresh:true})))
 assert.equal(calls,1);assert.ok(results.every(r=>r.state==='fresh'&&r.payload.data.market_pairs[0].market_id===2))
 const ttl=Date.parse(results[0].provenance.expiresAt!)-Date.parse(results[0].provenance.fetchedAt!);assert.ok(ttl>=120000&&ttl<120100)
}))

Deno.test('CMC USDC offers reviewed issuer networks without mapping a same-symbol asset',()=>{
 const choices=marketIdentityChoices({source_provider:'coinmarketcap',provider_id:'3408',platforms:{ethereum:'0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'}})
 assert.equal(choices.length,7);assert(choices.some(c=>c.canonicalAssetKey==='eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'&&c.chain==='base'))
 assert(choices.some(c=>c.canonicalAssetKey==='solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))
 assert.equal(marketIdentityChoices({source_provider:'coinmarketcap',provider_id:'999',normalized_symbol:'USDC'}).length,0)
 assert(!choices.some(c=>c.canonicalAssetKey.includes('0xff970')))
})

Deno.test('legacy CoinGecko USDC offers exactly the reviewed issuer representations',()=>{
 const c=marketIdentityChoices({source_provider:'coingecko',provider_id:'usd-coin',platforms:null});
 assert.equal(c.length,7);assert.ok(c.some(x=>x.canonicalAssetKey==='eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'));
 assert.deepEqual(marketIdentityChoices({source_provider:'coingecko',provider_id:'bridged-usdc',normalized_symbol:'USDC'}),[]);
})

const registered='0x45804880de22913dafe09f4980848ece6ecbaf78',solanaMint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
Deno.test('capabilities registered 2026-09-15 accept a documented request and reject a malformed one',()=>{
 assert.deepEqual(cmcParams('listingsHistorical',{date:'2026-09-01',limit:250}),{date:'2026-09-01T00:00:00.000Z',limit:'250',start:'1'})
 assert.equal(estimateCmcCredits('listingsHistorical',cmcParams('listingsHistorical',{date:'2026-09-01',limit:250})),3)
 assert.throws(()=>cmcParams('listingsHistorical',{date:'whenever'}),/invalid_time:date/)
 assert.throws(()=>cmcParams('listingsHistorical',{limit:1}),/missing_identifier/)
 assert.equal(cmcParams('exchangeMap',{limit:1,slug:'Binance'}).slug,'binance')
 assert.throws(()=>cmcParams('exchangeMap',{slug:'binance!'}),/invalid_identifier:slug/)
 assert.equal(cmcParams('exchangeHistory',{id:270,count:1,interval:'daily'}).count,'1')
 assert.equal(cmcParams('exchangeHistory',{id:270}).count,'30')
 assert.throws(()=>cmcParams('exchangeHistory',{id:270,count:400}),/invalid_parameter:count/)
 assert.throws(()=>cmcParams('exchangeHistory',{id:270,interval:'weekly'}),/daily/)
 assert.throws(()=>cmcParams('exchangeHistory',{count:1}),/missing_identifier/)
 assert.equal(cmcParams('blockchainStats',{id:1}).id,'1')
 assert.throws(()=>cmcParams('blockchainStats',{}),/missing_identifier/)
 assert.deepEqual(cmcParams('priceConversion',{amount:1,id:1}),{amount:'1',convert:'USD',id:'1'})
 assert.throws(()=>cmcParams('priceConversion',{amount:0,id:1}),/invalid_amount/)
 assert.throws(()=>cmcParams('priceConversion',{amount:1,id:1,convert:'USD,EUR,GBP,JPY'}),/invalid_parameter:convert/)
 assert.throws(()=>cmcParams('priceConversion',{id:1}),/missing_amount/)
 assert.equal(cmcParams('fiatMap',{limit:1}).limit,'1')
 assert.throws(()=>cmcParams('fiatMap',{limit:0}),/invalid_parameter:limit/)
})
Deno.test('registered DEX paths keep exact-contract identity, bounded batches and named candle periods',()=>{
 assert.deepEqual(cmcParams('dexHolderTags',{platform:'ethereum',tokenAddress:registered}),{platform:'ethereum',tokenAddress:registered})
 assert.throws(()=>cmcParams('dexHolderTags',{platform:'solana',tokenAddress:registered}),/invalid_contract_address/)
 assert.throws(()=>cmcParams('dexHolderTags',{platform:'ethereum'}),/missing_identifier/)
 assert.equal(cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,tag:'tag_whale',limit:5}).limit,'5')
 // Probed 2026-09-14: the provider rejects a holders list without a tag, and only the published tags exist.
 assert.throws(()=>cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,limit:5}),/invalid_holder_tag/)
 assert.throws(()=>cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,tag:'tag_people'}),/invalid_holder_tag/)
 assert.throws(()=>cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,tag:'tag_whale',limit:300}),/invalid_parameter:limit/)
 assert.throws(()=>cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,tag:'tag_whale',lastId:'x&url=evil'}),/invalid_dex_cursor/)
 const candles=cmcParams('dexCandles',{platform:'ethereum',address:registered,interval:'1h',limit:5,from:1700000000,to:1700003600})
 assert.deepEqual(candles,{address:registered,from:'1700000000',interval:'1h',limit:'5',platform:'ethereum',to:'1700003600',unit:'usd'})
 assert.throws(()=>cmcParams('dexCandles',{platform:'ethereum',address:registered,interval:'30s'}),/invalid_candle_interval/)
 assert.throws(()=>cmcParams('dexCandles',{platform:'ethereum',address:registered,unit:'eur'}),/invalid_candle_unit/)
 assert.throws(()=>cmcParams('dexCandles',{platform:'ethereum',address:registered,limit:1001}),/invalid_parameter:limit/)
 assert.throws(()=>cmcParams('dexCandles',{platform:'ethereum',address:registered,from:'yesterday'}),/invalid_time:from/)
 assert.equal(cmcParams('dexSearch',{q:'paxg',limit:3}).q,'paxg')
 assert.throws(()=>cmcParams('dexSearch',{q:'a'}),/invalid_search_query/)
 assert.throws(()=>cmcParams('dexSearch',{q:'paxg',platform:'unverified'}),/unverified_dex_platform/)
 assert.equal(cmcParams('dexBatch',{platform:'ethereum',addresses:[registered.toUpperCase().replace('0X','0x')]}).addresses,registered)
 assert.throws(()=>cmcParams('dexBatch',{platform:'ethereum',addresses:Array.from({length:51},()=>registered)}),/invalid_batch:addresses/)
 assert.throws(()=>cmcParams('dexBatch',{platform:'solana',addresses:[registered]}),/invalid_contract_address/)
 assert.equal(cmcParams('dexPriceBatch',{tokens:[{platform:'solana',address:solanaMint},{platform:'ethereum',address:registered}]}).tokens,`ethereum:${registered},solana:${solanaMint}`)
 assert.throws(()=>cmcParams('dexPriceBatch',{tokens:[{platform:'bitcoin',address:registered}]}),/invalid_contract_address/)
 assert.throws(()=>cmcParams('dexPriceBatch',{tokens:Array.from({length:51},()=>({platform:'ethereum',address:registered}))}),/invalid_batch:tokens/)
 assert.deepEqual(cmcRequestBody('dexBatch',cmcParams('dexBatch',{platform:'ethereum',addresses:[registered]})),{platform:'ethereum',addresses:[registered]})
 assert.deepEqual(cmcRequestBody('dexPriceBatch',cmcParams('dexPriceBatch',{tokens:[{platform:'ethereum',address:registered}]})),{tokens:[{platform:'ethereum',address:registered}]})
 assert.equal(cmcRequestBody('dexHolders',cmcParams('dexHolders',{platform:'ethereum',tokenAddress:registered,tag:'tag_whale',limit:5})).limit,5)
})
Deno.test('quote history accepts documented sub-daily intervals only inside their published windows',()=>{
 assert.equal(cmcParams('history',{id:1,interval:'hourly',count:744,time_start:'2026-08-15T00:00:00Z',time_end:'2026-09-14T00:00:00Z'}).interval,'hourly')
 assert.throws(()=>cmcParams('history',{id:1,interval:'hourly',count:745}),/invalid_parameter:count/)
 assert.throws(()=>cmcParams('history',{id:1,interval:'hourly',count:744,time_start:'2026-08-01T00:00:00Z',time_end:'2026-09-14T00:00:00Z'}),/history_window_too_large/)
 assert.equal(cmcParams('history',{id:1,interval:'5m',count:576}).count,'576')
 assert.throws(()=>cmcParams('history',{id:1,interval:'5m',count:577}),/history_window_too_large/)
 assert.throws(()=>cmcParams('history',{id:1,count:367}),/history_window_too_large/)
 assert.throws(()=>cmcParams('ohlcv',{id:1,interval:'hourly'}),/history_requires_daily_interval/)
})
Deno.test('k-line rows become named candle fields and dex holder responses have no observation clock',()=>{
 const body={data:[[1,2,0.5,1.5,100,1700000000,7]]}
 assert.deepEqual(cmcRows('dexCandles',body).rows,[{o:1,h:2,l:0.5,c:1.5,v:100,t:1700000000,traders:7}])
 assert.equal(cmcObservedAt(body,'dexCandles'),new Date(1700000000000).toISOString())
 assert.equal(cmcObservedAt({data:[[1,2,0.5,1.5,100,4102444800,7]]},'dexCandles'),null)
 assert.deepEqual(cmcRows('dexHolders',{data:{holders:[{address:registered,balance:'1'}]}}).rows,[{address:registered,balance:'1'}])
 assert.equal(cmcObservedAt({data:{holders:[{address:registered}]},status:{timestamp:'2026-09-15T00:00:00Z'}},'dexHolders'),null)
 assert.equal(cmcObservedAt({data:{tags:[]},status:{timestamp:'2026-09-15T00:00:00Z'}},'dexHolderTags'),null)
})
Deno.test('known native provider IDs remain verified when a second provider catalog appears',()=>{
 assert.equal(hasVerifiedCexIdentity({source_provider:'coinmarketcap',provider_id:'1',normalized_symbol:'BTC'},null),true);
 assert.equal(hasVerifiedCexIdentity({source_provider:'coinmarketcap',provider_id:'999999',normalized_symbol:'BTC'},null),false);
 assert.equal(hasVerifiedCexIdentity({source_provider:'coinmarketcap',provider_id:'1',normalized_symbol:'NOTBTC'},null),false);
})

// /v2/cryptocurrency/info facts: recorded verbatim, never inferred.
Deno.test('metadata facts keep the notice, self-reported supply, dates, tags, URLs and every deployment',async()=>{
 const info={notice:'  Trading is suspended.  ',self_reported_circulating_supply:1000,self_reported_market_cap:2000,self_reported_tags:['gaming'],
  infinite_supply:false,date_added:'2021-05-01T00:00:00.000Z',date_launched:'2021-04-20T00:00:00.000Z',category:'token',
  tags:['defi','yield-farming'],'tag-names':['DeFi','Yield farming'],'tag-groups':['SECTOR','CATEGORY'],
  urls:{website:['https://example.com'],technical_doc:['https://example.com/wp.pdf'],twitter:['https://x.com/example'],chat:['not a url']},
  contract_address:[
   {contract_address:'0x'+'1'.repeat(40),platform:{name:'Ethereum',coin:{id:'1027',name:'Ethereum',symbol:'ETH',slug:'ethereum'}}},
   {contract_address:'0x'+'2'.repeat(40),platform:{name:'BNB Smart Chain (BEP20)',coin:{id:'1839',name:'BNB',symbol:'BNB',slug:'bnb'}}},
   {contract_address:'TokenMintAddr11111111111111111111111111111',platform:{name:'Solana',coin:{id:'5426',name:'Solana',symbol:'SOL',slug:'solana'}}},
   {contract_address:'0x'+'3'.repeat(40),platform:{name:'Some Unlisted Network',coin:{id:'9',name:'X',symbol:'X',slug:'some-unlisted-network'}}},
   {contract_address:'   ',platform:{name:'Ethereum',coin:{slug:'ethereum'}}}]}
 const facts=await cmcAssetFacts(info,'2026-09-14T06:00:00Z')
 assert.equal(facts.notice,'Trading is suspended.')
 assert.equal(facts.noticeHash,await sha256Hex('Trading is suspended.'))
 assert.match(facts.noticeHash!,/^[0-9a-f]{64}$/)
 assert.equal(facts.selfReportedCirculatingSupply,1000);assert.equal(facts.selfReportedMarketCap,2000)
 assert.deepEqual(facts.selfReportedTags,['gaming']);assert.equal(facts.infiniteSupply,false)
 assert.equal(facts.dateAdded,'2021-05-01T00:00:00.000Z');assert.equal(facts.dateLaunched,'2021-04-20T00:00:00.000Z')
 assert.equal(facts.category,'token');assert.equal(facts.factsAt,'2026-09-14T06:00:00Z')
 assert.deepEqual(facts.tagGroups,[{tag:'defi',group:'SECTOR'},{tag:'yield-farming',group:'CATEGORY'}])
 assert.deepEqual(facts.urls,{website:['https://example.com'],technical_doc:['https://example.com/wp.pdf'],twitter:['https://x.com/example']})
 assert.equal(facts.deployments.length,4,'an empty address is not a deployment')
 assert.deepEqual(facts.deployments.map(d=>d.chain),['ethereum','bnb','solana',null])
 assert.equal(facts.deployments[3].platformName,'Some Unlisted Network','an unmapped platform keeps its reported name')
 assert.equal(facts.deployments[1].platformSlug,'bnb')
})
Deno.test('absent metadata fields stay null and a valid zero stays a zero',async()=>{
 const empty=await cmcAssetFacts({},null)
 assert.deepEqual(empty,{notice:null,noticeHash:null,selfReportedCirculatingSupply:null,selfReportedMarketCap:null,selfReportedTags:null,
  infiniteSupply:null,dateAdded:null,dateLaunched:null,category:null,tagGroups:[],deployments:[],urls:null,factsAt:null})
 const zero=await cmcAssetFacts({self_reported_circulating_supply:0,infinite_supply:true,date_added:'not a date'},'2026-09-14T06:00:00Z')
 assert.equal(zero.selfReportedCirculatingSupply,0);assert.equal(zero.infiniteSupply,true)
 assert.equal(zero.dateAdded,null,'an unparseable date is not a date')
 assert.deepEqual(cmcDeployments({contract_address:'not-an-array'}),[])
})
Deno.test('the catalogue metadata pass records facts and keeps the last good ones when a row is missing',async()=>{
 const item=(id:number)=>({id,name:'Asset '+id,symbol:'T'+id,cmc_rank:id,last_updated:new Date().toISOString(),quote:{USD:{price:id,market_cap:id*100}}})
 const info=(id:string)=>({id:Number(id),logo:'https://example.com/'+id+'.png',tags:['defi'],'tag-groups':['SECTOR'],notice:'Notice for '+id,
  platform:{slug:'ethereum',token_address:'0x'+'9'.repeat(40)},contract_address:[{contract_address:'0x'+'1'.repeat(40),platform:{name:'Ethereum',coin:{slug:'ethereum'}}}]})
 const response=(payload:any):any=>({payload,state:'fresh',reason:null,provenance:{fetchedAt:'2026-09-14T06:00:00Z'}})
 const rows=await fetchCoinmarketcapTopAssets(2,{kind:'job'},async(name:string,p:any)=>response({data:name==='listings'
  ?Array.from({length:p.limit},(_,i)=>item(p.start+i))
  :Object.fromEntries(String(p.id).split(',').filter(id=>id==='1').map(id=>[id,info(id)]))}))
 assert.equal(rows?.[0].facts?.notice,'Notice for 1')
 assert.equal(rows?.[0].factsAt,'2026-09-14T06:00:00Z')
 assert.deepEqual(rows?.[0].facts?.deployments,[{platformSlug:'ethereum',platformName:'Ethereum',chain:'ethereum',address:'0x'+'1'.repeat(40)}])
 assert.deepEqual(rows?.[0].platforms,{ethereum:'0x'+'9'.repeat(40)},'the single primary platform is unchanged')
 assert.equal(rows?.[1].facts,undefined,'an asset the metadata response omitted gains no invented facts')
 const kept={provider_id:'1',image_url:'https://example.com/1.png',image_source:'coinmarketcap',
  image_last_checked_at:new Date(Date.now()-60000).toISOString(),categories:['defi'],platforms:{}}
 let selected=''
 const db={from:()=>({select:(columns:string)=>{selected=columns;return {eq:()=>({limit:()=>({data:[kept]})})}}})}
 const reused=await fetchCoinmarketcapTopAssets(1,{supabase:db},async()=>response({data:[item(1)]}))
 // Fresh cached metadata means no metadata call and no facts in the payload:
 // the stored facts survive through the catalogue write's coalesce, and the
 // five-minute refresh never reads or resends every asset's metadata.
 assert.equal(reused?.[0].facts,undefined,'a skipped metadata pass carries no facts')
 assert.equal(reused?.[0].factsAt,undefined)
 assert.equal(/\bfacts\b/.test(selected),false,'the prior-row read does not load facts')
})
