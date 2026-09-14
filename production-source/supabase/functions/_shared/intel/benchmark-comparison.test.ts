import {assertEquals as eq,assertRejects,assertThrows} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {alignedBenchmark,benchmarkRequestPlan} from './benchmark-comparison.ts'
import {makeBenchmarkReceipt} from './benchmark-receipt.ts'
import {verifyReceipt,type Observation} from './investigation-evidence.ts'
import {normalizeCmcInvestigation} from './investigation-normalize.ts'
const end=Date.parse('2026-09-12T00:00:00Z'),day=86400000,now=end+3600000,subject='market:coinmarketcap:4705'
const o=(id:string,kind:'asset'|'index',value:number,t:number):Observation=>({id,subject:kind==='asset'?subject:'index:coinmarketcap:100',provider:'coinmarketcap',metric:kind==='asset'?'price':'index_level',unit:kind==='asset'?'USD':'index_points',value,observedAt:new Date(t).toISOString(),recordedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),sourceRef:'original:'+id,exportAllowed:false,aiAllowed:true})
const rows=()=>[o('a0','asset',10,end-day),o('a1','asset',0,end),o('i0','index',100,end-day),o('i1','index',110,end)]
Deno.test('benchmarks use actual identical timestamps, independent units and a valid zero ending price',()=>{
 const r=alignedBenchmark(rows(),subject,'100',now);eq(r.status,'comparable');eq(r.pairedCount,2);eq(r.rows[1].assetReturn,-100);eq(Math.round(r.rows[1].benchmarkReturn!),10);eq(Math.round(r.rows[1].difference!),-110);eq(r.rows[0].asset?.sourceRef,'original:a0')
})
Deno.test('mismatched times, currency, identities, future knowledge and contradictions do not form matching returns',()=>{
 for(const patch of [{observedAt:new Date(end-1000).toISOString()},{unit:'EUR'},{subject:'market:coinmarketcap:1'},{recordedAt:new Date(now+1).toISOString()}]){
  const r=rows();r[1]={...r[1],...patch};eq(alignedBenchmark(r,subject,'100',now).status,'insufficient_matching_times')
 }
 const r=rows();r.push({...r[1],id:'conflict',value:20});eq(alignedBenchmark(r,subject,'100',now).rows[1].asset,null)
 r[0].value=0;eq(alignedBenchmark(r.slice(0,4),subject,'100',now).status,'zero_baseline')
})
Deno.test('benchmark query plans share UTC boundaries across users and stay inside verified ten-row limits',()=>{
 eq(benchmarkRequestPlan(now-30*day,now),benchmarkRequestPlan(now+500-30*day,now+500));eq(benchmarkRequestPlan(now-30*day,now),{interval:'daily',time_end:new Date(end).toISOString(),count:10})
 assertThrows(()=>benchmarkRequestPlan(0,100*day));eq(benchmarkRequestPlan(now-day,now).count,2)
})
Deno.test('normalization retains index points, history quote identity and deduplicates overlapping query windows',async()=>{
 const env=(k:string)=>['CMC_ALLOW_HISTORICAL_RETENTION','CMC_ALLOW_AI_PROCESSING'].includes(k)?'true':undefined,fetched=new Date(now).toISOString(),expiry=new Date(now+3600000).toISOString()
 const index=await normalizeCmcInvestigation('cmc100History',{data:[{value:0,update_time:new Date(end).toISOString(),constituents:[]}]},{interval:'daily',count:'10'},fetched,expiry,expiry,env)
 eq(index.observations[0].unit,'index_points');eq(index.observations[0].value,0);eq(index.observations[0].observedAt,new Date(end).toISOString())
 const body={data:{'4705':{id:4705,name:'PAX Gold',quotes:[{timestamp:new Date(end).toISOString(),quote:{USD:{price:0}}}]}}}
 const a=await normalizeCmcInvestigation('history',body,{id:'4705',count:'10'},fetched,expiry,expiry,env),b=await normalizeCmcInvestigation('history',body,{id:'4705',count:'9'},fetched,expiry,expiry,env)
 eq(a.observations.length,1);eq(a.observations[0].id,b.observations[0].id);eq(a.observations[0].value,0)
 const wrong=await normalizeCmcInvestigation('history',body,{id:'1'},fetched,expiry,expiry,env);eq(wrong.observations.length,0)
})
Deno.test('saved benchmark receipts preserve both ends and original words without exporting restricted values',async()=>{
 const input={subject,marketSubject:subject,benchmark:'100' as const,question:'Original question',decision:'Original words',cursor:now,observations:rows()}
 const receipt=await makeBenchmarkReceipt(input,now);eq(receipt.observationRefs.length,4);eq(receipt.observations.length,0);eq(receipt.question,input.question);eq(receipt.decision,input.decision);eq((await verifyReceipt(receipt)).replay,'references_only')
 const allowed=await makeBenchmarkReceipt({...input,observations:rows().map(r=>({...r,exportAllowed:true}))},now);eq((await verifyReceipt(allowed)).verifiedObservations,4)
 const changed=structuredClone(allowed);changed.observationRefs[0].sourceRef='tampered';await assertRejects(()=>verifyReceipt(changed))
})
