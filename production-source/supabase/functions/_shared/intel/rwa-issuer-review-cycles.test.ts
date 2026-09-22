import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {issuerReviewAt,issuerReviewObservations,reviewCycleRestatements,ISSUER_REVIEW_CYCLES,ISSUER_REVIEW_SEED,ISSUER_REVIEWED_AT,OMITTED_FACT_REASON} from './rwa-issuer-evidence.ts'
import {rwaTermsProjection} from './rwa-terms.ts'
const iso=(t:number)=>new Date(t).toISOString()
const gold={rwa_id:1,tokens:[{crypto_id:4705,issuer_id:'68904c24abae9b5b9fb35815'},{crypto_id:5176,issuer_id:'68904e9cabae9b5b9fb358ac'},{crypto_id:34212,issuer_id:'68905a7babae9b5b9fb35a8d'},{crypto_id:20245,issuer_id:'68904cceabae9b5b9fb35839'}]}
const ondo={rwa_id:2,tokens:[{crypto_id:38093,issuer_id:'688ca4ccabae9b5b9fb3167a'}]}
// A year after the last cycle. Nothing here treats that as meaningful.
const longAfter=Date.parse('2027-09-16T12:56:00.000Z')

Deno.test('review cycles carry wording forward, replace changed facts, withdraw omissions and report bad references',()=>{
 const fact=(key:string,summary=key)=>({key,label:key,summary,sourceUrl:'https://issuer.example/terms'})
 const token={rwaId:'1',cryptoId:'10',issuerId:'i',name:'Token',issuer:'Issuer',market:null}
 const seed=[{...token,reviewedAt:'2026-01-01T00:00:00.000Z',version:'v1',facts:[fact('a'),fact('b')]},
  {...token,reviewedAt:'2026-01-02T00:00:00.000Z',version:'v2',facts:[fact('c')]}]
 const problems:string[]=[]
 const out=reviewCycleRestatements(seed,[
  {version:'c1',reviewedAt:'2026-01-06T00:00:00.000Z',changes:{'10':[fact('b','changed')]},omitted:['10:c']},
  {version:'c2',reviewedAt:'2026-01-11T00:00:00.000Z'},
 ],problems)
 eq(problems,[])
 eq(out.map(r=>[r.version,r.reviewedAt,r.facts.map(f=>`${f.key}=${f.summary}`),(r.lapsed??[]).map(f=>f.key)]),[
  ['c1','2026-01-06T00:00:00.000Z',['a=a','b=changed'],['c']],
  ['c2','2026-01-11T00:00:00.000Z',['a=a','b=changed'],[]]])
 eq(seed.flatMap(r=>r.facts.map(f=>f.summary)),['a','b','c'])
 // A cycle read MUCH later than the one before it is not a problem: nothing
 // expired in between, so there is no gap to report.
 const late:string[]=[]
 const far=reviewCycleRestatements(seed,[{version:'late',reviewedAt:'2027-01-10T00:00:00.000Z'}],late)
 eq(late,[])
 eq(far.map(r=>r.facts.map(f=>f.key)),[['a','b','c']])
 // An explicit lapse withdraws everything the cycle would have carried, and
 // records the stated reason rather than a date.
 const noted:string[]=[]
 const lapsed=reviewCycleRestatements(seed,[{version:'stop',reviewedAt:'2026-01-10T00:00:00.000Z',lapse:'Deploy credentials were unavailable'}],noted)
 eq(noted,[])
 eq(lapsed.map(r=>[r.facts.length,(r.lapsed??[]).map(f=>f.key),r.lapseReason]),[[0,['a','b','c'],'Deploy credentials were unavailable']])
 const bad:string[]=[]
 reviewCycleRestatements(seed,[{version:'bad',reviewedAt:'2026-01-02T00:00:00.000Z',omitted:['10:z','99:a','x'],changes:{'99':[fact('a')]}}],bad)
 eq(bad,['bad: review date must follow every earlier review','bad: omits unknown fact 10:z','bad: omits unknown fact 99:a','bad: omits unknown fact x','bad: changes unknown token 99'])
 // A key omitted and re-supplied in the same cycle is carried, not withdrawn.
 const both:string[]=[]
 const resupplied=reviewCycleRestatements(seed,[{version:'c3',reviewedAt:'2026-01-06T00:00:00.000Z',omitted:['10:c'],changes:{'10':[fact('c','re-read')]}}],both)
 eq(both,[])
 eq(resupplied.map(r=>[r.facts.map(f=>`${f.key}=${f.summary}`),(r.lapsed??[]).length]),[[['a=a','b=b','c=re-read'],0]])
})

Deno.test('the shipped issuer cycles restate every current fact under one date and stay current forever',async()=>{
 const problems:string[]=[];reviewCycleRestatements(ISSUER_REVIEW_SEED,ISSUER_REVIEW_CYCLES,problems);eq(problems,[])
 // No cycle carries a window, because there is no window to carry.
 for(const cycle of ISSUER_REVIEW_CYCLES)eq((cycle as Record<string,unknown>).expiresAt,undefined)
 const cycle=ISSUER_REVIEW_CYCLES[0],start=Date.parse(cycle.reviewedAt)
 const before=await issuerReviewObservations([gold,ondo],iso(start-1)),after=await issuerReviewObservations([gold,ondo],iso(start))
 const key=(o:{metric:string;metadata?:Record<string,unknown>})=>`${o.metadata?.cryptoId}:${o.metric.slice('issuer_'.length)}`
 const restated=after.filter(o=>o.metadata?.reviewVersion===cycle.version),omitted=new Set(cycle.omitted??[])
 eq(before.filter(o=>o.metadata?.reviewVersion===cycle.version),[])
 eq([...new Set(before.map(key))].filter(k=>!omitted.has(k)&&!restated.some(o=>key(o)===k)),[])
 // Every restated observation is open-ended: null expiry, no stale state.
 assert(restated.every(o=>o.observedAt===cycle.reviewedAt&&o.expiresAt===null&&o.state===undefined&&o.aiAllowed===false&&o.exportAllowed===true))
 // Earlier versions keep their original words and review clock.
 const original=before.find(o=>o.metadata?.cryptoId==='4705'&&o.metric==='issuer_redemption')!
 eq(original.observedAt,ISSUER_REVIEWED_AT);assert(String(original.value).includes('completion can take several business days'))
 assert(String(restated.find(o=>key(o)==='4705:redemption')?.value).includes('no delivery completion time is stated'))
 assert(restated.some(o=>key(o)==='38093:off_hours'))
 const observations=[...before,...after]
 for(const [subject,cryptoId] of [['rwa:coinmarketcap:1','4705'],['rwa:coinmarketcap:2','38093'],['rwa:coinmarketcap:1','5176'],['rwa:coinmarketcap:1','34212'],['rwa:coinmarketcap:1','20245']]) {
  const review=issuerReviewAt(observations,subject,cryptoId,start+1000)
  eq(review.state,'reviewed');assert(review.facts.every(o=>o.observedAt===cycle.reviewedAt))
  // A YEAR later the same review is still current. This is the whole point.
  eq(issuerReviewAt(observations,subject,cryptoId,longAfter).state,'reviewed')
 }
 eq(issuerReviewAt(observations,'rwa:coinmarketcap:2','38093',longAfter).schedule,'ondo_conventional_1')
})

Deno.test('an explicit withdrawal, and only that, produces the withdrawn review states',async()=>{
 const fact=(key:string,summary=key)=>({key,label:key,summary,sourceUrl:'https://issuer.example/terms'})
 const token={rwaId:'2',cryptoId:'38093',issuerId:'688ca4ccabae9b5b9fb3167a',name:'Token',issuer:'Issuer',market:null}
 const seed=[{...token,reviewedAt:'2026-01-01T00:00:00.000Z',version:'v1',facts:[fact('a'),fact('b')]}]
 // A cycle that omits one fact withdraws exactly that one; a cycle that
 // declares a lapse withdraws all of them and records the stated reason.
 eq(reviewCycleRestatements(seed,[{version:'c1',reviewedAt:'2026-02-01T00:00:00.000Z',omitted:['38093:b']}])
  .map(r=>[r.facts.map(f=>f.key),(r.lapsed??[]).map(f=>f.key),r.lapseReason]),[[['a'],['b'],null]])
 eq(reviewCycleRestatements(seed,[{version:'c2',reviewedAt:'2026-03-01T00:00:00.000Z',lapse:'The issuer withdrew the document'}])
  .map(r=>[r.facts.length,(r.lapsed??[]).map(f=>f.key),r.lapseReason]),[[0,['a','b'],'The issuer withdrew the document']])
 assert(OMITTED_FACT_REASON.includes('withdrawn'))
 // And the state machine: a withdrawn observation is the ONLY thing that moves
 // a token off `reviewed`, at any instant, however far in the future.
 const subject='rwa:coinmarketcap:2'
 const live=await issuerReviewObservations([ondo],'2026-09-16T13:00:00.000Z')
 assert(live.every(o=>o.expiresAt===null&&o.state===undefined))
 eq(issuerReviewAt(live,subject,'38093',longAfter).state,'reviewed')
 const withdraw=(o:typeof live[number])=>({...o,id:`${o.id}:withdrawn`,observedAt:'2026-09-17T00:00:00.000Z',
  sourceRef:`${o.sourceRef}:withdrawn`,state:'stale' as const,reason:OMITTED_FACT_REASON})
 const some=issuerReviewAt([...live,withdraw(live[0])],subject,'38093',longAfter)
 // The withdrawn fact keeps its recorded words on the board, just not its force.
 eq(some.state,'partially_reviewed');eq(some.facts.length,issuerReviewAt(live,subject,'38093',longAfter).facts.length)
 eq(issuerReviewAt([...live,...live.map(withdraw)],subject,'38093',longAfter).state,'review_expired')
})

Deno.test('a review cycle keeps terms arithmetic available however long ago the seed was reviewed',async()=>{
 const cycle=ISSUER_REVIEW_CYCLES[0],subject='rwa:coinmarketcap:1'
 const observations=[...await issuerReviewObservations([gold,ondo],'2026-09-12T22:13:17.000Z'),...await issuerReviewObservations([gold,ondo],cycle.reviewedAt)]
 const paxg=rwaTermsProjection(observations,subject,'4705',longAfter,430)
 eq(paxg.state,'reviewed');eq(paxg.underlyingUnits,430);eq(paxg.redemption?.threshold?.meetsQuantity,true)
 eq(rwaTermsProjection(observations,subject,'20245',longAfter,2).underlyingUnits,2)
 eq(rwaTermsProjection(observations,'rwa:coinmarketcap:2','38093',longAfter,5).underlyingUnits,null)
})
