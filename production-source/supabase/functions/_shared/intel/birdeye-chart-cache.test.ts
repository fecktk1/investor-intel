import {assertEquals,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {birdeyeChartRequest,sharedBirdeyeChart} from './birdeye-chart-cache.ts'
import {birdeyeGet,configureBirdeye,__resetBirdeyeStateForTests} from '../birdeye-client.ts'
import {checkProviderBudget} from '../provider-budget.ts'
const addr='0x11111111111111111111111111111111111111AA',now=Date.parse('2026-09-11T08:00:20Z'),at=now-3600000
const bar={t:at,o:10,h:12,l:9,c:11,v:0}

Deno.test('shared Birdeye requests use stable public identity and bounded two-minute windows',()=>{
  assertEquals(birdeyeChartRequest('base',addr,'1H',now).path,birdeyeChartRequest('base',addr.toLowerCase(),'1H',now+60000).path)
  const q=new URLSearchParams(birdeyeChartRequest('base',addr,'1H',now).path.split('?')[1])
  assertEquals(q.get('currency'),'usd');assertEquals(q.get('chart_type'),'price');assertEquals(Number(q.get('time_to'))-Number(q.get('time_from')),7*86400)
  assertEquals(birdeyeChartRequest('solana','AbCdEf123','1D',now).address,'AbCdEf123')
  for(const address of [addr+'&currency=native',addr+'?x=1'])assertThrows(()=>birdeyeChartRequest('base',address,'1H',now))
  assertThrows(()=>birdeyeChartRequest('unknown',addr,'1H',now))
})
Deno.test('fresh, held, malformed and failed cache claims cause no paid calls',async()=>{
  for(const claim of [{error:{message:'offline'},data:null},{error:null,data:{claimed:true}},{error:null,data:{claimed:false,candles:[bar],state:'fresh',fetchedAt:'2026-09-11T08:00:00Z'}},{error:null,data:{claimed:false,candles:[],state:'refreshing'}}]){
    let paid=0
    const db={rpc:async()=>claim},r=await sharedBirdeyeChart(db,'base',addr,'1H',{},async()=>{paid++;throw Error('unexpected')},now)
    assertEquals(paid,0);if(claim.data?.state==='fresh'){assertEquals(r.candles[0].v,0);assertEquals(r.fetchedAt,'2026-09-11T08:00:00Z')}
  }
})
Deno.test('successful refresh normalizes market bars and forces the authorized server budget context',async()=>{
  const calls:any[]=[]
  const db={rpc:async(name:string,args:any)=>{
    calls.push({name,args})
    if(name==='intel_birdeye_chart_claim')return {data:{claimed:true,leaseId:'11111111-1111-4111-8111-111111111111',candles:[]},error:null}
    return {data:{applied:true,candles:args.p_candles,state:'fresh',fetchedAt:'2026-09-11T08:00:21Z'},error:null}
  }}
  const r=await sharedBirdeyeChart(db,'base',addr,'1H',{supabase:'wrong-client'},async(_path,opts)=>{
    assertEquals(opts.ctx?.supabase,db);assertEquals(opts.ctx?.strictBudget,true)
    return {ok:true,status:200,data:{data:{items:[{unixTime:at/1000,o:10,h:12,l:9,c:11,v:0,notes:'upstream text'},{unixTime:'invalid',c:1}]}}}
  },now)
  assertEquals(r.candles,[bar]);assertEquals(calls[1].args.p_candles,[bar]);assertEquals(calls[1].args.p_error,null)
})
Deno.test('a denied refresh retains the original last-good clock and a lost lease cannot replace it',async()=>{
  for(const lostLease of [false,true]){
    const original={candles:[bar],state:'stale',fetchedAt:'2026-09-11T07:00:00Z'}
    const db={rpc:async(name:string,args:any)=>{
      if(name==='intel_birdeye_chart_claim')return {data:{...original,claimed:true,leaseId:'11111111-1111-4111-8111-111111111111'},error:null}
      assertEquals(args.p_candles,null);assertEquals(args.p_error,'access_denied')
      return {data:lostLease?{applied:false}:{...original,applied:true,reason:'access_denied'},error:null}
    }}
    const r=await sharedBirdeyeChart(db,'base',addr,'1H',{},async()=>({ok:false,status:403,data:null}),now)
    assertEquals(r.candles,[bar]);assertEquals(r.fetchedAt,original.fetchedAt);assertEquals(r.state,'stale');assertEquals(r.reason,lostLease?'cache_unavailable':'access_denied')
  }
})
Deno.test('strict budgets reject absent, malformed, failed and throwing quota verification',async()=>{
  for(const db of [null,{rpc:async()=>({error:{message:'denied'}})},{rpc:async()=>({data:[]})},{rpc:async()=>({data:{allowed:'true'}})},{rpc:async()=>{throw Error('offline')}}])assertEquals((await checkProviderBudget(db,{provider:'birdeye',hardCap:100,strict:true})).allowed,false)
  assertEquals((await checkProviderBudget({rpc:async()=>({data:{allowed:true},error:null})},{provider:'birdeye',hardCap:100,strict:true})).allowed,true)
})
Deno.test('real Birdeye transport does not fetch when strict quota verification fails',async()=>{
  const names=['BIRDEYE_API_KEY','BIRDEYE_ALLOW_NONPROD_KEY','BIRDEYE_ENRICHMENT_ENABLED'],old=new Map(names.map(k=>[k,Deno.env.get(k)]))
  try{
    Deno.env.set('BIRDEYE_API_KEY','qa-only');Deno.env.set('BIRDEYE_ALLOW_NONPROD_KEY','true');Deno.env.set('BIRDEYE_ENRICHMENT_ENABLED','true');__resetBirdeyeStateForTests()
    let fetched=0
    configureBirdeye({monthlyCallCap:100,fetchImpl:async()=>{fetched++;return new Response('{}')}})
    const db={rpc:async()=>({data:null,error:{message:'cache authority unavailable'}}),from:()=>({insert:async()=>({error:null})})}
    assertEquals(await birdeyeGet('/defi/ohlcv?address=qa',{chain:'base',ctx:{supabase:db,strictBudget:true,apiKey:'qa-only'}}),null);assertEquals(fetched,0)
  }finally{for(const [k,v]of old)if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v);__resetBirdeyeStateForTests()}
})

Deno.test('strict chart transport has cancellation and makes one reserved attempt before cooldown',async()=>{
  const names=['BIRDEYE_API_KEY','BIRDEYE_ALLOW_NONPROD_KEY','BIRDEYE_ENRICHMENT_ENABLED'],old=new Map(names.map(k=>[k,Deno.env.get(k)]))
  try{
    Deno.env.set('BIRDEYE_API_KEY','qa-only');Deno.env.set('BIRDEYE_ALLOW_NONPROD_KEY','true');Deno.env.set('BIRDEYE_ENRICHMENT_ENABLED','true');__resetBirdeyeStateForTests()
    let fetched=0,reserved=0
    configureBirdeye({monthlyCallCap:100,maxRetries:3,fetchImpl:async(_url,init)=>{fetched++;assertEquals(init?.signal instanceof AbortSignal,true);return new Response('{}',{status:503})}})
    const db={rpc:async()=>{reserved++;return {data:{allowed:true},error:null}},from:()=>({insert:async()=>({error:null})})}
    const r=await birdeyeGet('/defi/ohlcv?address=qa',{chain:'base',ctx:{supabase:db,strictBudget:true,apiKey:'qa-only'}})
    assertEquals(r?.status,503);assertEquals(fetched,1);assertEquals(reserved,1)
  }finally{for(const [k,v]of old)if(v===undefined)Deno.env.delete(k);else Deno.env.set(k,v);__resetBirdeyeStateForTests()}
})
