import {assert,assertEquals as eq,assertRejects} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {issuerReviewAt,issuerReviewObservations,recordIssuerReviews,reviewedRelationships,ISSUER_REVIEWED_AT,ISSUER_REVIEW_RETENTION_MS,OMITTED_FACT_REASON,EXTENDED_ISSUER_REVIEWED_AT} from './rwa-issuer-evidence.ts'
import {ondoConventionalSession} from './investigation-sessions.ts'
import {makeResearchReceipt,verifyReceipt} from './investigation-evidence.ts'
import {investigationRange} from './investigation-service.ts'
const now=Date.parse(ISSUER_REVIEWED_AT)+1000,iso=(t:number)=>new Date(t).toISOString(),subject='rwa:coinmarketcap:2'
const record={rwa_id:2,tokens:[{crypto_id:38093,issuer_id:'688ca4ccabae9b5b9fb3167a',name:'Renamed',symbol:'Renamed'}]}
Deno.test('expanded issuer reviews keep separate dates and do not transfer rights to a same-issuer token',async()=>{
 const gold={rwa_id:1,tokens:[{crypto_id:5176,issuer_id:'68904e9cabae9b5b9fb358ac'},{crypto_id:37082,issuer_id:'68904e9cabae9b5b9fb358ac'},{crypto_id:34212,issuer_id:'68905a7babae9b5b9fb35a8d'},{crypto_id:20245,issuer_id:'68904cceabae9b5b9fb35839'}]},at=Date.parse(EXTENDED_ISSUER_REVIEWED_AT)
 eq(await issuerReviewObservations([gold],iso(at-1)),[])
 const facts=await issuerReviewObservations([gold],iso(at+1000));eq(facts.length,9);assert(facts.every(f=>f.metadata?.cryptoId!=='37082'&&f.observedAt===EXTENDED_ISSUER_REVIEWED_AT&&f.aiAllowed===false))
 assert(facts.some(f=>String(f.value).includes('not recognized as valid XAUm')));assert(facts.some(f=>String(f.value).includes('10 grams')))
 eq((await issuerReviewObservations([record,gold],'2026-09-18T00:00:00Z')).filter(o=>o.metadata?.reviewVersion==='issuer-review-2').length,9)
 // A year on, version 2 is STILL recorded with its own words and clock. A
 // review does not stop being emitted because a date went by.
 const later=(await issuerReviewObservations([gold],'2027-09-19T04:53:06.000Z')).filter(o=>o.metadata?.reviewVersion==='issuer-review-2')
 eq(later.length,9);assert(later.every(o=>o.observedAt===EXTENDED_ISSUER_REVIEWED_AT&&o.expiresAt===null))
})
Deno.test('issuer evidence requires exact underlying, token and issuer IDs, never a name or ticker',()=>{
 eq(new Set(reviewedRelationships([record]).map(r=>`${r.rwaId}:${r.cryptoId}:${r.issuerId}`)).size,1)
 for(const bad of [{...record,rwa_id:1},{...record,tokens:[{...record.tokens[0],crypto_id:1}]},{...record,tokens:[{...record.tokens[0],issuer_id:'other'}]},{rwa_id:2,tokens:[{name:'NVIDIA Tokenized Stock (Ondo)',symbol:'NVDAon'}]}])eq(reviewedRelationships([bad]).length,0)
 eq(reviewedRelationships([record,record]).length,reviewedRelationships([record]).length)
 eq(reviewedRelationships([record,{...record,tokens:[{...record.tokens[0],issuer_id:'other'}]}]).length,0)
})
Deno.test('source review IDs are stable across reloads and never borrow a market timestamp',async()=>{
 const a=await issuerReviewObservations([record],iso(now)),b=await issuerReviewObservations([record],iso(now+1000))
 eq(a.length,4);eq(a.map(o=>o.id),b.map(o=>o.id));eq(a[0].observedAt,ISSUER_REVIEWED_AT);eq(a[0].recordedAt,iso(now));assert(a.every(o=>o.provider==='investor-intel-editorial'&&o.aiAllowed===false&&o.exportAllowed))
 eq(await issuerReviewObservations([record],iso(now-2000)),[])
 // Recording the same review a year later produces the same ids and the same
 // open-ended rows: there is no date at which version 1 stops being recorded.
 const far=await issuerReviewObservations([record],'2027-09-17T17:55:45.000Z')
 eq(far.filter(o=>o.metadata?.reviewVersion==='issuer-review-1').map(o=>o.id),a.map(o=>o.id))
 assert(far.every(o=>o.expiresAt===null))
})
Deno.test('issuer facts respect recorded knowledge and conflicting identities, and never expire on a clock',async()=>{
 const facts=await issuerReviewObservations([record],iso(now))
 eq(issuerReviewAt(facts,subject,'38093',now-1).state,'unavailable');eq(issuerReviewAt(facts,subject,'38093',now).state,'reviewed');eq(issuerReviewAt(facts,subject,'4705',now).state,'unavailable')
 // Seven days on, seven years on: still reviewed, with every fact in force.
 for(const at of [Date.parse('2026-09-17T17:55:45.000Z'),Date.parse('2033-01-01T00:00:00.000Z')]) {
  const later=issuerReviewAt(facts,subject,'38093',at)
  eq(later.state,'reviewed');eq(later.facts.length,4);eq(later.schedule,'ondo_conventional_1');eq(later.market,'XNAS')
 }
 // Only an explicit withdrawal changes that.
 const withdrawn=facts.map(o=>({...o,id:`${o.id}:w`,observedAt:'2026-09-20T00:00:00.000Z',state:'stale' as const,reason:OMITTED_FACT_REASON}))
 const gone=issuerReviewAt([...facts,...withdrawn],subject,'38093',Date.parse('2033-01-01T00:00:00.000Z'))
 eq(gone.state,'review_expired');eq(gone.facts.length,4);eq(gone.schedule,null);eq(gone.market,null)
 eq(issuerReviewAt([...facts,{...facts[0],id:'conflict',universe:'other',metadata:{...facts[0].metadata,issuerId:'other'}}],subject,'38093',now).state,'unavailable')
})
Deno.test('saved RWA receipts retain original reviewed words and source clocks without provider reads',async()=>{
 const facts=await issuerReviewObservations([record],iso(now)),receipt=await makeResearchReceipt({subject,lens:'sessions',question:'Which clock constrains this token?',decision:'Review issuer conditions.',cursor:now,observations:facts},now)
 const result=await verifyReceipt(JSON.parse(JSON.stringify(receipt)));eq(result.verifiedObservations,4);assert(result.receipt.observations.some(o=>String(o.value).includes('multiplier')))
 eq(result.receipt.observations[0].observedAt,ISSUER_REVIEWED_AT)
 await assertRejects(()=>verifyReceipt({...receipt,observations:receipt.observations.map((o,i)=>i?o:{...o,value:'Changed later'})}),Error,'receipt_integrity_mismatch')
})
Deno.test('recorded issuer evidence reuses first committed clocks and reports persistence failure',async()=>{
 const first=await issuerReviewObservations([record],iso(now)),calls:any[]=[]
 const db={rpc:async(name:string,args:any)=>{calls.push([name,args]);return {error:null}},from:()=>{const q:any={select:()=>q,in:()=>q,gt:()=>q,then:(fn:any)=>Promise.resolve(fn({data:first.map(observation=>({observation}))}))};return q}}
 const result=await recordIssuerReviews(db,[record],now+60000);eq(result[0].recordedAt,iso(now));eq(calls.length,1);assert(!JSON.stringify(calls).includes('user_id'))
 // Storage retention is the general observation policy and is separate from the
 // review: the rows themselves carry no expiry at all.
 const rows=calls[0][1].p_rows as {expiresAt:string|null;retainUntil:string}[]
 assert(rows.every(r=>r.expiresAt===null&&Date.parse(r.retainUntil)===now+60000+ISSUER_REVIEW_RETENTION_MS))
 await assertRejects(()=>recordIssuerReviews({...db,rpc:async()=>({error:{message:'down'}})},[record],now),Error,'issuer_review_storage_unavailable')
})
for(const [time,state,name]of[
 ['2026-03-08T23:59:00Z','outside_conventional_windows',null],
 ['2026-03-09T00:05:00Z','within_conventional_window','Overnight'],
 ['2026-03-09T13:30:00Z','outside_conventional_windows',null],
 ['2026-03-09T13:31:00Z','within_conventional_window','Core'],
 ['2026-11-02T01:05:00Z','within_conventional_window','Overnight'],
 ['2026-11-02T14:31:00Z','within_conventional_window','Core'],
 ['2026-09-12T00:05:00Z','outside_conventional_windows',null],
 ['2026-09-07T15:00:00Z','exception_rules_required',null],
 ['2026-11-27T18:10:00Z','exception_rules_required',null],
]as const)Deno.test(`conventional issuer schedule respects exact boundaries and DST: ${time}`,()=>{
 const result=ondoConventionalSession(Date.parse(time));eq(result.state,state);eq(result.current?.name??null,name);assert(result.actualAvailability.includes('unverified'))
})
Deno.test('unverified calendar years and issuer history cursor injection are rejected',()=>{
 eq(ondoConventionalSession(Date.parse('2029-01-02T15:00:00Z')).state,'unavailable')
 eq(investigationRange({from:now-1000,to:now,cursor:{time:iso(now),id:`issuer:${'a'.repeat(64)}`}},now).cursor?.id,`issuer:${'a'.repeat(64)}`)
 let rejected=false;try{investigationRange({from:now-1000,to:now,cursor:{time:iso(now),id:'issuer:a),id.gt.x'}},now)}catch{rejected=true}assert(rejected)
})
