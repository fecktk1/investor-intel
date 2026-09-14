import {assertEquals as eq,assertRejects,assertThrows} from 'jsr:@std/assert'
import {dexCohortMembers,dexCohortService} from './dex-cohort-service.ts'
import {marketSourceReference} from './market-source-reference.ts'
import {cmcParams} from '../market-assets/cmc-capabilities.ts'
const now=Date.parse('2026-09-12T06:00:00Z'),date=new Date(now-1000).toISOString(),address='0x'+'a'.repeat(40),id='11111111-1111-4111-8111-111111111111',actor={userId:id,orgId:id}
const params=cmcParams('dexNew',{platformIds:'199',pageSize:25}),row={pid:199,addr:address,n:'Fixture',sym:'SAME',p:0,mcap:0,pt:(now-2000)/1000}
const payload={data:{leaderboardList:[row],nextPageIndex:null}},provenance={fetchedAt:date,expiresAt:new Date(now+60000).toISOString()}
function fixture(){
 const state:{cohort:any;failed:boolean;policy:boolean;requests:any[];calls:any[]}={cohort:null,failed:false,policy:true,requests:[],calls:[]}
 const db={from(table:string){let mutation:any=null;const q:any=new Proxy({},{get:(_,method)=>{
  const result=()=>{if(table==='provider_quota_budgets')return {data:{config:{CMC_ALLOW_HISTORICAL_RETENTION:String(state.policy),CMC_ALLOW_AI_PROCESSING:'false'}},error:null};if(state.failed)return {data:null,error:{message:'offline'}};if(mutation&&!state.cohort)state.cohort={...mutation,id};return {data:state.cohort,error:null}}
  if(method==='then')return (resolve:any)=>Promise.resolve(result()).then(resolve)
  return (...args:any[])=>{state.calls.push([table,method,...args]);if(method==='upsert')mutation=args[0];if(method==='maybeSingle'||method==='single')return Promise.resolve(result());return q}
 }});return q},rpc(name:string,args:any){state.calls.push([name,args]);return Promise.resolve({data:[{subject:'eip155:8453:'+address,observation:null}],error:state.failed?{message:'offline'}:null})}}
 const request=async(...args:any[])=>{state.requests.push(args);return {state:'fresh',payload,provenance,reason:null} as any}
 return {db,state,request}
}
async function captureInput(){const r=await marketSourceReference('dexNew',params,payload,provenance);return {operation:'capture',capability:r.capability,parameters:r.parameters,payloadHash:r.payloadHash,retrievedAt:r.retrievedAt}}
Deno.test('discovery membership preserves exact contracts, zero and its source clock; undated cap cannot become a historical weight',()=>{
 const [m]=dexCohortMembers('dexNew',payload,params,new Date(now).toISOString(),date)
 eq(m.subject,'eip155:8453:'+address);eq(m.initialPrice,0);eq(m.reportedMarketCapUsd,0);eq(m.initialMarketCapUsd,null);eq(m.joinedAt,new Date(now).toISOString());eq(m.initialObservedAt,new Date(now-2000).toISOString())
 const invalid={data:{leaderboardList:[{...row,pid:1}]}};assertThrows(()=>dexCohortMembers('dexNew',invalid,params,date,date),Error,'invalid_dex_cohort_source')
 const future=dexCohortMembers('dexNew',{data:{leaderboardList:[{...row,pt:now/1000+1}]}},params,date,date)[0];eq(future.initialPrice,null);eq(future.initialObservedAt,null)
})
Deno.test('meme-stage duplicates share one original member; conflicting quotes fail instead of selecting an arbitrary baseline',()=>{
 const body={data:{newCreations:[row],aboutGraduates:[row],graduates:[]}}
 eq(dexCohortMembers('dexMeme',body,params,date,date).map(m=>m.stages),[['newCreations','aboutGraduates']])
 assertThrows(()=>dexCohortMembers('dexMeme',{data:{...body.data,aboutGraduates:[{...row,p:1}]}},params,date,date),Error,'dex_cohort_conflicting_duplicate')
})
Deno.test('capture binds the reviewed response, retries preserve original membership and no upstream refresh is allowed',async()=>{
 const {db,state,request}=fixture(),input=await captureInput(),first=await dexCohortService(db,input,actor,now,request),second=await dexCohortService(db,input,actor,now+1000,request)
 eq(first.cohort,second.cohort);eq(state.requests.length,1);eq(state.requests[0][2].kind,'render');eq(state.requests[0][2].maxCalls,0)
 eq(state.calls.filter(c=>c[1]==='upsert').length,1);eq(state.calls.find(c=>c[1]==='upsert')[3],{onConflict:'cohort_key',ignoreDuplicates:true})
 eq(first.cohort.source_reference.payloadHash,input.payloadHash);eq(first.cohort.created_at,new Date(now).toISOString())
 eq(first.quotes?.rows[0].observation,null)
})
Deno.test('a newer shared response cannot silently replace reviewed discovery membership',async()=>{
 const {db,state,request}=fixture(),input=await captureInput();await assertRejects(()=>dexCohortService(db,{...input,payloadHash:'f'.repeat(64)},actor,now,request),Error,'dex_cohort_source_changed')
 eq(state.cohort,null);eq(state.calls.some(c=>c[1]==='upsert'),false)
})
Deno.test('expired policy, invalid input, failed reads and knowledge before capture stay distinct',async()=>{
 const f=fixture();f.state.policy=false;eq((await dexCohortService(f.db,await captureInput(),actor,now,f.request)).state,'unsupported');eq(f.state.requests.length,0)
 const broken=fixture(),input=await captureInput();broken.state.failed=true;await assertRejects(()=>dexCohortService(broken.db,input,actor,now,broken.request),Error,'dex_cohort_storage_unavailable')
 const read=fixture();read.state.cohort={id,created_at:new Date(now).toISOString(),members:[]};eq((await dexCohortService(read.db,{cohortId:id,at:now-1},actor,now,read.request)).state,'not_yet_recorded');eq(read.state.calls.some(c=>c[0]==='intel_dex_cohort_quotes'),false)
 await assertRejects(()=>dexCohortService(read.db,{cohortId:id,at:now+1},actor,now,read.request),Error,'invalid_dex_cohort_time')
 await assertRejects(()=>dexCohortService(read.db,{cohortId:id,members:[]},actor,now,read.request),Error,'invalid_dex_cohort_request')
})
