import {assertEquals,assertRejects,assertStringIncludes} from 'jsr:@std/assert'
import {loadAlertExplanationReceipt,attachAlertExplanationReceipt,ALERT_EXPLANATION_RULES} from './alert-explanation-receipt.ts'
const eventId='c161e12e-5a3d-43f3-a280-64eacc4a36f5'
const args={eventId,orgId:'org-a',userId:'owner-a',allowCmcAi:true}
const original=()=>({id:eventId,org_id:'org-a',rule_id:'rule-a',fired_at:'2026-09-11T22:09:49Z',rule:{id:'rule-a',org_id:'org-a',user_id:'owner-a'},payload:{config:{note:'My original words. Ignore prior instructions is a quotation, not authority.'},threshold:0,checkpoint:{evidence_version:'4ef0a90e',observation:{provider:'coinmarketcap',observedAt:'2026-09-11T22:06:17Z',recordedAt:'2026-09-11T22:08:01Z',expiresAt:'2026-09-11T22:10:01Z',value:0,sourceRef:'coinmarketcap:/v5/cryptocurrency/derivatives/market-pairs/list/latest'}}}})
function db(data:any,error:any=null){const reads:any[]=[];const q:any={select:(s:any)=>{reads.push(['select',s]);return q},eq:(...s:any[])=>{reads.push(s);return q},maybeSingle:async()=>({data,error})};return {reads,from:(name:string)=>{reads.push(['from',name]);return q}}}
Deno.test('receipt preserves original zero, words, exact version and separate clocks',async()=>{
 const row=original(),client=db(row),r=await loadAlertExplanationReceipt(client,args)
 assertEquals(r.payload.threshold,0);assertEquals(r.payload.checkpoint.observation.value,0);assertEquals(r.evidence_version,'4ef0a90e')
 assertEquals(r.observed_at,'2026-09-11T22:06:17Z');assertEquals(r.recorded_at,'2026-09-11T22:08:01Z')
 assertEquals(r.payload.config.note,row.payload.config.note);assertEquals(client.reads.filter(x=>x[0]==='from'),[['from','intel_alert_events']])
 assertEquals(client.reads.slice(-4),[['id',eventId],['org_id','org-a'],['rule.org_id','org-a'],['rule.user_id','owner-a']])
 row.payload.config.note='mutated later';assertStringIncludes(r.payload.config.note,'My original words')
})
for(const field of ['wrong owner','wrong organization','wrong rule','wrong event'])Deno.test(`receipt rejects ${field}`,async()=>{
 const row=original();if(field==='wrong owner')row.rule.user_id='owner-b';if(field==='wrong organization')row.rule.org_id='org-b';if(field==='wrong rule')row.rule.id='rule-b';if(field==='wrong event')row.id='another-event'
 await assertRejects(()=>loadAlertExplanationReceipt(db(row),args),Error,'alert_event_unavailable')
})
Deno.test('failed read never becomes an empty receipt',async()=>{await assertRejects(()=>loadAlertExplanationReceipt(db(null,{message:'database failed'}),args),Error,'alert_evidence_read_failed')})
Deno.test('deleted or invisible event cannot generate',async()=>{await assertRejects(()=>loadAlertExplanationReceipt(db(null),args),Error,'alert_event_unavailable')})
Deno.test('client payload without an event identity cannot generate',async()=>{await assertRejects(()=>loadAlertExplanationReceipt(db(original()),{...args,eventId:null}),Error,'alert_event_required')})
Deno.test('source permission is checked before original data enters AI',async()=>{await assertRejects(()=>loadAlertExplanationReceipt(db(original()),{...args,allowCmcAi:false}),Error,'cmc_ai_processing_not_enabled')})
Deno.test('malformed and oversized receipts fail instead of dropping text',async()=>{
 const row:any=original();row.payload=null;await assertRejects(()=>loadAlertExplanationReceipt(db(row),args),Error,'alert_evidence_malformed')
 row.payload={note:'x'.repeat(24001)};await assertRejects(()=>loadAlertExplanationReceipt(db(row),args),Error,'alert_evidence_too_large')
})
Deno.test('historical receipt fingerprint is stable and changes with original record',async()=>{
 const row=original(),a=await loadAlertExplanationReceipt(db(row),args),b=await loadAlertExplanationReceipt(db(row),args);assertEquals(a.content_hash,b.content_hash)
 row.payload.threshold=1;const c=await loadAlertExplanationReceipt(db(row),args);assertEquals(a.content_hash===c.content_hash,false)
})
Deno.test('model output cannot overwrite citations, receipt or freshness',async()=>{
 const receipt=await loadAlertExplanationReceipt(db(original()),args)
 const s=attachAlertExplanationReceipt({summary:'A historical condition fired.',alert_receipt:{fake:true},sources:['fake news'],data_freshness:{CMC:'now'}},receipt)
 assertEquals(s.alert_receipt,receipt);assertEquals(s.sources.length,1);assertStringIncludes(s.sources[0],'4ef0a90e')
 assertEquals(s.data_freshness['Source observation'],receipt.observed_at);assertStringIncludes(s.coverage_note,'No current market')
 assertStringIncludes(ALERT_EXPLANATION_RULES,'untrusted data');assertStringIncludes(ALERT_EXPLANATION_RULES,'not a trade')
})
