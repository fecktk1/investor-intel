import {assertEquals as eq,assert} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {readCmcContractEvidence} from './cmc-contract-evidence.ts'
import {evaluateThesisConditions} from './thesis-conditions.ts'
import {conditionSource,matchesConditionSource} from './condition-source.ts'
import {venueConditionChoices} from './venue-condition-sources.ts'
import {projectDexEvidence,contractEvidencePreview} from './cmc-contract-projection.ts'
import {readConnectedAssetIdentity} from './connected-asset-identity.ts'
const now=Date.parse('2026-09-12T03:00:00Z'),subject='eip155:1:0x'+'a'.repeat(40)
const observation=(metric:string,value=0)=>({id:`cmc:${metric}`,subject,provider:'coinmarketcap',metric,value,unit:metric==='holder_count'?'accounts':'USD',periodSeconds:metric==='holder_count'?86400:null,
 observedAt:new Date(now-3600000).toISOString(),recordedAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+3600000).toISOString(),aiAllowed:true,sourceRef:'coinmarketcap:/v1/dex/holders/trend/list:exact',metadata:{chain:'ethereum',contract:subject.split(':')[2]}})
function database(failMetric?:string){const reads:any[]=[];return {reads,from(table:string){if(table==='provider_quota_budgets'){const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:{config:{CMC_ALLOW_AI_PROCESSING:'true',CMC_ALLOW_HISTORICAL_RETENTION:'true',CMC_SOURCE_POLICY_EXPIRES_AT:'2026-09-30T00:00:00Z'}}})};return q};const r:any={table,filters:[]};reads.push(r);const q:any={};for(const method of ['select','eq','gte','lte','gt','order'])q[method]=(...args:any[])=>{r.filters.push([method,...args]);return q};q.limit=(limit:number)=>{r.limit=limit;const metric=r.filters.find((f:any)=>f[1]==='metric')?.[2];return Promise.resolve(metric===failMetric?{error:Error('failed'),data:null}:{data:[{observation:observation(metric)},{observation:{...observation(metric),id:'wrong',subject:'native:bitcoin'}},{observation:{...observation(metric),id:'denied',aiAllowed:false}},{observation:{...observation(metric),id:'future',recordedAt:new Date(now+1).toISOString()}}],error:null})};return q}}}
Deno.test('connected CMC evidence keeps independent metric bounds, exact identity, zero and per-record authorization',async()=>{
 const db=database(),r=await readCmcContractEvidence(db,subject,now)
 // Five metrics since the holder-tag lane (proposal 20) added `holder_tag_count`, bounded at the eight tags ONE capture
 // writes. Every metric still gets its own read, so a busy tape cannot crowd out another metric's citation.
 eq(r.status,'available');eq(r.observations.length,5);assert(r.observations.every(o=>o.value===0&&o.subject===subject&&o.aiAllowed));eq(db.reads.map(r=>r.limit),[3,63,101,101,17])
 const native=database();eq((await readCmcContractEvidence(native,'native:bitcoin',now)).status,'unsupported');eq(native.reads.length,0)
})
Deno.test('connected CMC evidence failures remain partial/error, never absent coverage',async()=>{
 const r=await readCmcContractEvidence(database('holder_count'),subject,now);eq(r.status,'partial');eq(r.sources.find(s=>s.metric==='holder_count')?.status,'error');eq(r.observations.length,4)
})
Deno.test('daily CMC holder evidence reaches a thesis condition without relaxing fast venue freshness or losing its source',()=>{
 const holder=observation('holder_count'),rule={id:'h',metric:'holder_count',threshold:0,threshold_unit:'accounts',time_window:'24h',comparator:'gte',source_metric:'contract:coinmarketcap:holder_count'}
 const result=evaluateThesisConditions([rule],{cmc_contract_state:{observations:[holder]}},subject,now)[0]
 eq(result.met,true);eq(result.observation?.id,holder.id);eq(result.observation?.observedAt,holder.observedAt)
})
Deno.test('contract condition choices reject native subjects, other chains, invalid counts and invented pool identity',()=>{
 const good=observation('holder_count')
 for(const bad of [{...good,subject:'native:bitcoin',metadata:{}},{...good,metadata:{...good.metadata,chain:'base'}},{...good,value:-1},{...good,value:1.5},{...good,unit:'people'},{...good,periodSeconds:3600}]){
  eq(matchesConditionSource(bad,'contract:coinmarketcap:holder_count','holder_count'),false)
  eq(venueConditionChoices([bad as any],{},now).length,0)
 }
 eq(conditionSource({...good,subject:'native:bitcoin',metadata:{}}),null)
 eq(matchesConditionSource(observation('liquidity_event_usd'),'contract:coinmarketcap:liquidity_event_usd','liquidity_event_usd'),false)
})
Deno.test('contract conditions retain daily cadence but reject old, future-known and expired versions',()=>{
 const h=observation('holder_count'),rule={id:'h',metric:'holder_count',threshold:0,threshold_unit:'accounts',time_window:'24h',comparator:'gte',source_metric:'contract:coinmarketcap:holder_count'}
 for(const change of [{observedAt:new Date(now-172800001).toISOString()},{recordedAt:new Date(now+1).toISOString()},{expiresAt:new Date(now-1).toISOString()}])eq(evaluateThesisConditions([rule],{cmc_contract_state:{observations:[{...h,...change}]}},subject,now)[0].met,null)
 eq(venueConditionChoices([h as any],{},now)[0].observation.id,h.id)
})
Deno.test('compact contract research keeps each metric and whole original citations',()=>{
 const rows=[observation('price'),...Array.from({length:31},(_,i)=>({...observation('holder_count'),id:'h'+i})),observation('liquidity_event_usd')]
 const preview=contractEvidencePreview(rows as any);eq(preview.length,6);eq(new Set(preview.map(o=>o.metric)).size,3)
 assert(preview.every(o=>rows.includes(o as any)))
})
Deno.test('legacy holder identity is coalesced only after the declared interval was known',()=>{
 const old:any={...observation('holder_count'),universe:'aggregate'},updated={...old,id:'declared',universe:'cmc:interval:1:2',recordedAt:new Date(now).toISOString()}
 eq(projectDexEvidence([old,updated],now).map(o=>o.id),['declared']);eq(projectDexEvidence([old,updated],now-1).map(o=>o.id),[old.id,'declared'])
 eq(old.universe,'aggregate')
})
Deno.test('current rights denial prevents retained contract reads and AI reuse',async()=>{
 const db={from(){const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data:{config:{CMC_ALLOW_AI_PROCESSING:'false',CMC_ALLOW_HISTORICAL_RETENTION:'true'}}})};return q}}
 const r=await readCmcContractEvidence(db,subject,now);eq(r.status,'restricted');eq(r.observations.length,0)
})
Deno.test('exact contract catalog lookup is bounded, canonical and fails closed on ambiguous or failed matches',async()=>{
 let call:any
 const make=(data:any,error:any=null)=>({rpc(name:string,args:any){call={name,args};return Promise.resolve({data,error})}})
 const r=await readConnectedAssetIdentity(make([{provider_id:'4705',name:'PAX Gold',image_url:null}]),subject)
 eq(r.cmcId,'4705');eq(r.contractSubject,subject);eq(call.name,'intel_cmc_contract_chart_identity');eq(call.args.p_chain,'ethereum')
 eq((await readConnectedAssetIdentity(make([{provider_id:'4705'},{provider_id:'2'}]),subject)).state,'ambiguous')
 let failed=false;try{await readConnectedAssetIdentity(make(null,Error('failed')),subject)}catch{failed=true}assert(failed)
})
Deno.test('market to contract relationship requires selected network or one exact representation',async()=>{
 const address=subject.split(':')[2],data={source_provider:'coinmarketcap',provider_id:'4705',name:'Example',platforms:{ethereum:address,base:address}}
 const db={from(){const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve({data})};return q}}
 eq((await readConnectedAssetIdentity(db,'market:coinmarketcap:4705')).contractSubject,null)
 eq((await readConnectedAssetIdentity(db,'market:coinmarketcap:4705',subject)).contractSubject,subject)
 let failed=false;try{await readConnectedAssetIdentity(db,'market:coinmarketcap:4705','eip155:42161:'+address)}catch{failed=true}assert(failed)
})
Deno.test('verified connected pack preserves the same observation across market research and contract thesis conditions',()=>{
 const market='market:coinmarketcap:4705',holder=observation('holder_count'),rule={id:'h',metric:'holder_count',threshold:0,threshold_unit:'accounts',time_window:'24h',comparator:'gte',source_metric:'contract:coinmarketcap:holder_count'}
 const pack={connected_identity:{requested:market,state:'verified',contractSubject:subject,marketSubject:market},cmc_contract_state:{observations:[holder]}}
 eq(evaluateThesisConditions([rule],pack,market,now)[0].observation?.id,holder.id)
 eq(evaluateThesisConditions([rule],pack,'market:coinmarketcap:1027',now)[0].met,null)
})
