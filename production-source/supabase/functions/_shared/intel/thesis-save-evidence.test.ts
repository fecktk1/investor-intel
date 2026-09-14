import { assertEquals, assertRejects } from 'jsr:@std/assert'
import { thesisPriceSnapshot, thesisSaveEvidence } from './thesis-save-evidence.ts'
import { projectThesisRecordedEvidence } from './thesis-recorded-evidence.ts'

const actor={userId:'owner',orgId:'org'},key='market:coinmarketcap:4705'
function db(row:any,error:any=null){const filters:any[]=[];const q:any={select:()=>q,eq:(...a:any[])=>{filters.push(a);return q},maybeSingle:()=>Promise.resolve({data:row,error})};return {from:()=>q,filters}}
const row={org_id:'org',user_id:'owner',subject_canonical_key:key,content_hash:'reviewed',pack:{asset:{canonical_key:key,symbol:'PAXG'},market_summary:{current_price:0,field_evidence:{current_price:{value:0,as_of:'2026-09-11T01:00:00Z',provider:'coinmarketcap'}}}},source_provenance:{original:'id'},data_coverage:{material_gaps:[]}}
Deno.test('saving uses exactly the reviewed owner/org/asset version without fresh assembly',async()=>{
 const client=db(row);let calls=0
 const result=await thesisSaveEvidence(client,actor,{canonicalKey:key},'reviewed',async()=>{calls++;return {pack:{}}})
 assertEquals(calls,0);assertEquals(result.contentHash,'reviewed');assertEquals(result.sourceProvenance,row.source_provenance)
 assertEquals(client.filters,[['org_id','org'],['user_id','owner'],['subject_canonical_key',key],['content_hash','reviewed'],['window','current']])
 assertEquals(thesisPriceSnapshot(result.pack).current_price,0);assertEquals(thesisPriceSnapshot(result.pack).field_evidence,row.pack.market_summary.field_evidence)
})
Deno.test('missing, mismatched, private and failed versions cannot substitute fresh evidence',async()=>{
 for(const value of [null,{...row,user_id:'someone-else'},{...row,org_id:'other'}, {...row,pack:{asset:{canonical_key:'native:ethereum'}}}]){
  await assertRejects(()=>thesisSaveEvidence(db(value),actor,{canonicalKey:key},'reviewed',async()=>{throw Error('must_not_run')}))
 }
 await assertRejects(()=>thesisSaveEvidence(db(row,{message:'offline'}),actor,{canonicalKey:key},'reviewed',async()=>null),Error,'evidence_version_read_failed')
})
Deno.test('legacy creation still assembles and missing numerical fields remain missing',async()=>{
 const result=await thesisSaveEvidence({},actor,{canonicalKey:key},null,async()=>({legacy:true}))
 assertEquals(result,{legacy:true});assertEquals(thesisPriceSnapshot({}).current_price,null)
})
Deno.test('shared thesis evidence exposes only frozen source fields and obeys current CMC rights',()=>{
 const original={...row,pack:{...row.pack,private_notes:'never shared',portfolio_state:{balance:42},derivatives_state:{observations:[{id:'a'}]},cmc_contract_state:{observations:[{id:'b'}]}}}
 const shown=projectThesisRecordedEvidence(original,true)
 assertEquals(shown.fields.current_price,row.pack.market_summary.field_evidence.current_price)
 assertEquals(JSON.stringify(shown).includes('never shared'),false);assertEquals(JSON.stringify(shown).includes('balance'),false)
 const hidden=projectThesisRecordedEvidence(original,false)
 assertEquals(hidden.fields.current_price.value,null);assertEquals(hidden.specialist.cmc_contract_state.observations,[])
 assertEquals(original.pack.market_summary.current_price,0)
})
