import {assertEquals,assertRejects,assertThrows} from 'jsr:@std/assert'
import {narrativeInputDocument,narrativeRetentionDeadline,recordNarrativeInput,readNarrativeInput,attachNarrativeInput,narrativeInputFailureCode} from './narrative-input-replay.ts'
const now=Date.parse('2026-09-12T12:00:00Z'),policy={allowed:true,days:30,expires:now+18*86400000}
const fixture=()=>({content_hash:'old-root',slug:'ai-infrastructure',taxonomy:{id:'taxonomy'},membership_context:{rows:[]},member_assets:[{cached:false,subject:{canonical_key:'market:coinmarketcap:29835',source_provider:'coinmarketcap',chain:'solana'},headlines:{market:{current_price:0,field_evidence:{current_price:{provider:'coinmarketcap',value:0,observed_at:new Date(now-1000).toISOString(),recorded_at:new Date(now).toISOString()}}},holders:{records:[{top10Percent:0,sourceRef:'original-record'}]}}}],narrative_signals:[{title:'Original source words',observed_at:null}],category_rotation:[],macro_rotation:[],source_states:{some_source:'error'}})
const artifactId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',actor={userId:'owner',orgId:'org'},params={artifactId,section:'members',page:1}
Deno.test('narrative retention diagnostics expose only fixed failure categories',()=>{
 assertEquals(narrativeInputFailureCode(new Error('narrative_input_retention_expired')),'narrative_input_retention_expired')
 for(const error of [new Error('private SQL or authored source text'),{message:'narrative_input_bounds'},'private text',null])assertEquals(narrativeInputFailureCode(error),'narrative_input_storage_unavailable')
})
function db(result:any,trace:string[]=[]){const q:any={select:()=>q,eq:()=>q,maybeSingle:()=>Promise.resolve(result)};return {from:(table:string)=>{trace.push(table);return q}}}
Deno.test('root replay preserves original text, zero, source errors and exact identity; cache flags alone do not version evidence',async()=>{
 const p=fixture(),before=JSON.stringify(p),first=await narrativeInputDocument(p);p.member_assets[0].cached=true
 assertEquals((await narrativeInputDocument(p)).hash,first.hash);p.member_assets[0].cached=false;assertEquals(JSON.stringify(p),before)
 assertEquals(first.document.source_states.some_source,'error');assertEquals(first.document.member_assets[0].headlines.market.current_price,0)
 p.narrative_signals[0].title='Changed source words';assertEquals((await narrativeInputDocument(p)).hash===first.hash,false)
})
Deno.test('private records, oversized roots and unknown CMC retention clocks fail closed',async()=>{
 await assertRejects(()=>narrativeInputDocument({...fixture(),member_assets:[{...fixture().member_assets[0],user_id:'private-user'}]}),Error,'private_narrative_input')
 await assertRejects(()=>narrativeInputDocument({...fixture(),narrative_signals:[{title:'x'.repeat(500000)}]}),Error,'narrative_input_too_large')
 assertThrows(()=>narrativeRetentionDeadline(fixture(),{...policy,allowed:false},now),Error,'retention_restricted')
 const p=fixture();p.member_assets[0].headlines.market.field_evidence={} as any
 assertThrows(()=>narrativeRetentionDeadline(p,policy,now),Error,'clock_unavailable')
})
Deno.test('source retention uses original clocks and policy expiry without resetting lifetime on replay',()=>{
 const p=fixture();p.member_assets[0].headlines.market.field_evidence.current_price.observed_at=new Date(now-29*86400000).toISOString()
 assertEquals(narrativeRetentionDeadline(p,policy,now),new Date(now+86400000).toISOString())
 p.member_assets[0].headlines.market.field_evidence.current_price.observed_at=new Date(now-31*86400000).toISOString()
 assertThrows(()=>narrativeRetentionDeadline(p,policy,now),Error,'retention_expired')
})
Deno.test('CMC asset identity does not assign unrelated historical or exchange evidence to CMC retention',()=>{
 const p=fixture(),old='2026-07-20T03:40:03.205Z'
 Object.assign(p.member_assets[0].headlines.market.field_evidence.current_price,{provider:'coinmarketcap'})
 Object.assign(p.member_assets[0].headlines,{historical:{analogs:[{observed_at:old,evidence_refs:[{table:'intel_market_regime',id:'original-regime'}]}]},cex:{top_ticker:{provider:'binance',as_of:old,price:0}}})
 const original=JSON.stringify(p)
 assertEquals(narrativeRetentionDeadline(p,policy,now),new Date(policy.expires).toISOString())
 assertEquals(JSON.stringify(p),original,'Original words, dates, values and references are unchanged')
 Object.assign(p.member_assets[0].headlines.market.field_evidence.current_price,{observed_at:old})
 assertThrows(()=>narrativeRetentionDeadline(p,policy,now),Error,'retention_expired')
})
Deno.test('explicit CMC provider scopes retain child clocks and source references even without a CMC asset identity',()=>{
 const p=fixture();p.member_assets[0].subject.source_provider='coingecko'
 Object.assign(p.member_assets[0].headlines.market.field_evidence.current_price,{provider:'coinmarketcap',observed_at:new Date(now-29*86400000).toISOString()})
 assertEquals(narrativeRetentionDeadline(p,policy,now),new Date(now+86400000).toISOString())
 const market=p.member_assets[0].headlines.market as any;delete market.field_evidence.current_price.provider
 market.field_evidence.current_price.sourceRef='coinmarketcap:/v3/cryptocurrency/quotes/latest:original'
 assertEquals(narrativeRetentionDeadline(p,policy,now),new Date(now+86400000).toISOString())
})
Deno.test('recording requires successful immutable storage before an artifact can name the input',async()=>{
 const p=fixture(),{hash}=await narrativeInputDocument(p),recorded=new Date(now-500).toISOString()
 const receipt=await recordNarrativeInput({rpc:async()=>({data:{id:`narrative-input:${hash}`,content_hash:hash,slug:p.slug,recorded_at:recorded,retain_until:new Date(now+86400000).toISOString()}})},p,now,async()=>policy)
 assertEquals(receipt.recorded_at,recorded);const report={summary:'Original authored output'};assertEquals(attachNarrativeInput(report,receipt).summary,report.summary);assertEquals(Object.keys(report),['summary'])
 await assertRejects(()=>recordNarrativeInput({rpc:async()=>({error:{message:'unavailable'}})},p,now,async()=>policy),Error,'storage_unavailable')
})
Deno.test('private owner and org isolation are enforced before any shared snapshot read',async()=>{
 const trace:string[]=[],service=db({data:{}},trace)
 for(const a of [null,{id:artifactId,org_id:'other'},{id:artifactId,org_id:'org',private_owner_id:'other'}])assertEquals((await readNarrativeInput(db({data:a}),service,actor,params,now,async()=>policy)).state,'unavailable')
 assertEquals(trace,[])
 await assertRejects(()=>readNarrativeInput(db({error:{}}),service,actor,params,now,async()=>policy),Error,'read_failed')
 await assertRejects(()=>readNarrativeInput(db({}),service,actor,{...params,page:9},now,async()=>policy),Error,'invalid_narrative_input_request')
})
Deno.test('authorized bounded replay returns exact old records; missing, expired, restricted and corrupted snapshots stay distinct',async()=>{
 const p=fixture(),{document,hash}=await narrativeInputDocument(p),ref={version:1,id:`narrative-input:${hash}`,content_hash:hash,slug:p.slug},a={id:artifactId,org_id:actor.orgId,private_owner_id:actor.userId,artifact_type:'narrative_report',structured:{narrative_input_receipt:ref}},user=db({data:a})
 const row={id:ref.id,content_hash:hash,slug:p.slug,pack:document,retain_until:new Date(now+86400000).toISOString()}
 const result=await readNarrativeInput(user,db({data:row}),actor,params,now,async()=>policy)
 assertEquals(result.state,'available');assertEquals(result.records,[document.member_assets[0]]);assertEquals(result.hasMore,false)
 assertEquals((await readNarrativeInput(user,db({data:null}),actor,params,now,async()=>policy)).state,'unavailable')
 assertEquals((await readNarrativeInput(user,db({data:{...row,pack:null}}),actor,params,now,async()=>policy)).state,'expired')
 assertEquals((await readNarrativeInput(user,db({data:row}),actor,params,now,async()=>({...policy,allowed:false}))).state,'restricted')
 await assertRejects(()=>readNarrativeInput(user,db({data:{...row,pack:{...document,slug:'changed'}}}),actor,params,now,async()=>policy),Error,'receipt_invalid')
 assertEquals((await readNarrativeInput(db({data:{...a,structured:{}}}),db({}),actor,params,now,async()=>policy)).state,'not_recorded')
})
