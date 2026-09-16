import {assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {evaluateThesis,evalThesisEvidenceBatch} from './thesis-monitor.ts'

const thesis={id:'thesis',org_id:'org',user_id:'owner',subject_canonical_key:'native:bitcoin',stance:'bullish',visibility:'private'}
const pack={pack:{news_state:{stories:[{title:'Recorded protocol upgrade',url:'https://example.org/evidence',published_at:'2026-09-11T08:00:00Z',summary:'Original source text',sentiment:'positive'}]}}}
function database(options:Record<string,any>={}){
 const writes:any[]=[],rpcs:any[]=[]
 return {
  writes,rpcs,
  rpc:async(name:string,args:any)=>{rpcs.push({name,args});return name==='can_access_intel'?{data:options.allowed!==false}:name==='intel_record_thesis_condition'?{data:{state:'triggered'}}:options.candidatesError?{error:{message:'private database details'}}:{data:options.candidates||[]}},
  from(table:string){
   let action='read'
   const result=()=>{
    if(table==='org_members')return {data:options.member===false?null:{org_id:'org'}}
    if(action==='upsert')return options.evidenceError?{error:{code:'42P10'}}:{data:options.inserted||[{id:'evidence'}]}
    if(action==='update')return options.engineError?{error:{code:'42501'}}:{data:{id:'thesis'}}
    if(options.contextError)return {error:{message:'private database details'}}
    return {data:table==='intel_thesis_snapshots'?null:table==='intel_thesis_rules'?options.rules||[]:[]}
   }
   const q:any={
    select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,gt:()=>q,
    upsert:(rows:any)=>{action='upsert';writes.push({table,rows});return q},
    update:(patch:any)=>{action='update';writes.push({table,patch});return q},
    maybeSingle:async()=>result(),
    then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject),
   }
   return q
  },
 }
}
const readPack=async()=>pack as any
Deno.test('failed thesis evidence writes cannot advance engine fields or claim saved evidence',async()=>{
 const db=database({evidenceError:true})
 await assertRejects(()=>evaluateThesis(db,thesis,{readPack}),Error,'thesis_evidence_save_unavailable')
 eq(db.writes.map(w=>w.table),['intel_thesis_evidence'])
})
Deno.test('failed context reads cannot turn missing history into a fresh quality result',async()=>{
 const db=database({contextError:true})
 await assertRejects(()=>evaluateThesis(db,thesis,{readPack}),Error,'thesis_context_unavailable');eq(db.writes,[])
})
Deno.test('failed engine persistence returns a retryable failure rather than success',async()=>{
 await assertRejects(()=>evaluateThesis(database({engineError:true}),thesis,{readPack}),Error,'thesis_evaluation_save_unavailable')
})
Deno.test('concurrent duplicate evidence is not reported as another newly saved record',async()=>{
 const result=await evaluateThesis(database({inserted:[]}),thesis,{readPack});eq(result.ok,true);eq(result.new_evidence,0)
})
Deno.test('saved evidence keeps original source content and updates only engine fields',async()=>{
 const db=database(),result=await evaluateThesis(db,thesis,{readPack})
 eq(result.new_evidence,1);eq(db.writes[0].rows[0].event_snapshot.summary,'Original source text')
 eq(db.writes[0].rows[0].impact_source,'engine');eq(db.writes[0].rows[0].user_id,'owner')
 for(const field of ['status','stance','conviction','bull_thesis','bear_thesis','user_notes'])eq(field in db.writes[1].patch,false)
})
Deno.test('dry run produces a proposal and writes no evidence or engine fields',async()=>{
 const db=database(),result=await evaluateThesis(db,thesis,{readPack,dryRun:true});eq(result.new_evidence,1);eq(db.writes,[])
})
Deno.test('revoked membership or access prevents private pack reads and all writes',async()=>{
 for(const options of [{member:false},{allowed:false}]){
  const db=database(options);let reads=0
  const result=await evaluateThesis(db,thesis,{readPack:async()=>{reads++;return pack as any}})
  eq(result.error,'access_unavailable');eq(reads,0);eq(db.writes,[])
 }
})
Deno.test('failed candidate RPC and unsuccessful evaluations are counted as failures',async()=>{
 eq(await evalThesisEvidenceBatch(database({candidatesError:true})),{evaluated:0,failed:1,dry_run:false})
 eq(await evalThesisEvidenceBatch(database({candidates:[{id:'missing-subject'}]})),{evaluated:0,failed:1,dry_run:false})
})

Deno.test('activated conditions refresh an expired shared pack once without provider enrichment and retain the new evidence version',async()=>{
 const db=database({rules:[{id:'rule',thesis_id:'thesis',status:'active',alert_rule_id:'alert',rule_kind:'confirmation',description:'Original zero level',metric:'price',comparator:'gte',threshold:0,threshold_unit:'USD',time_window:'current'}]}),calls:any[]=[]
 const observed=new Date(Date.now()-60000).toISOString(),recorded=new Date(Date.now()-30000).toISOString()
 const result=await evaluateThesis(db,thesis,{readPack:async(_db,_subject,opts)=>{calls.push(opts);return calls.length===1?{pack:{},cached:true,contentHash:'old'} as any:{pack:{market_summary:{retained_observations:[{id:'new',subject:'market:coinmarketcap:1',metric:'price',unit:'USD',value:100,provider:'coinmarketcap',sourceRef:'shared:new',observedAt:observed,recordedAt:recorded,expiresAt:new Date(Date.now()+60000).toISOString()}]}},contentHash:'current-version'} as any}})
 eq(calls.length,2);eq(calls[1].force,true);eq(calls.every(c=>c.allowLiveEnrichment===false),true);eq(result.evidence_version,'current-version')
 const saved=db.rpcs.find(r=>r.name==='intel_record_thesis_condition');eq(saved.args.p_evidence_version,'current-version');eq(saved.args.p_observation.id,'new');eq(saved.args.p_met,true);eq(saved.args.p_expected.description,'Original zero level')
 // The condition receipt carries the evidentiary verdict for its market-move metric.
 // This fake database retains no agreement window, so it is an unmeasured research lead.
 eq(saved.args.p_observation.agreement.metric_agreement,'unmeasured');eq(saved.args.p_observation.agreement.research_lead,true)
})
Deno.test('evaluation uses the clock after assembly and accepts evidence learned during that assembly',async()=>{
 const db=database({rules:[{id:'rule',thesis_id:'thesis',status:'active',alert_rule_id:'alert',metric:'price',comparator:'gte',threshold:0,threshold_unit:'USD',time_window:'current'}]})
 await evaluateThesis(db,thesis,{readPack:async()=>{await new Promise(resolve=>setTimeout(resolve,15));const recordedAt=new Date().toISOString();return {contentHash:'assembled-now',cached:false,pack:{market_summary:{retained_observations:[{id:'during-assembly',subject:'market:coinmarketcap:1',metric:'price',unit:'USD',value:0,provider:'coinmarketcap',sourceRef:'retained:source',observedAt:recordedAt,recordedAt,expiresAt:new Date(Date.now()+60000).toISOString()}]}}} as any}})
 eq(db.rpcs.find(r=>r.name==='intel_record_thesis_condition').args.p_met,true)
})
