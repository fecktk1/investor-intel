import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {issuerReviewAt,issuerReviewObservations,reviewCycleRestatements,ISSUER_REVIEW_CYCLES,ISSUER_REVIEW_SEED,ISSUER_REVIEW_WINDOW_MS,ISSUER_REVIEWED_AT} from './rwa-issuer-evidence.ts'
import {rwaTermsProjection} from './rwa-terms.ts'
const iso=(t:number)=>new Date(t).toISOString()
const gold={rwa_id:1,tokens:[{crypto_id:4705,issuer_id:'68904c24abae9b5b9fb35815'},{crypto_id:5176,issuer_id:'68904e9cabae9b5b9fb358ac'},{crypto_id:34212,issuer_id:'68905a7babae9b5b9fb35a8d'},{crypto_id:20245,issuer_id:'68904cceabae9b5b9fb35839'}]}
const ondo={rwa_id:2,tokens:[{crypto_id:38093,issuer_id:'688ca4ccabae9b5b9fb3167a'}]}
// The last seed review (structured terms) expires at this instant.
const seedExpired=Date.parse('2026-09-19T22:13:16.000Z')

Deno.test('review cycles carry wording forward, replace changed facts, keep omissions and report gaps or bad references',()=>{
 const fact=(key:string,summary=key)=>({key,label:key,summary,sourceUrl:'https://issuer.example/terms'})
 const token={rwaId:'1',cryptoId:'10',issuerId:'i',name:'Token',issuer:'Issuer',market:null}
 const seed=[{...token,reviewedAt:'2026-01-01T00:00:00.000Z',expiresAt:'2026-01-08T00:00:00.000Z',version:'v1',facts:[fact('a'),fact('b')]},
  {...token,reviewedAt:'2026-01-02T00:00:00.000Z',expiresAt:'2026-01-09T00:00:00.000Z',version:'v2',facts:[fact('c')]}]
 const problems:string[]=[]
 const out=reviewCycleRestatements(seed,[
  {version:'c1',reviewedAt:'2026-01-06T00:00:00.000Z',expiresAt:'2026-01-13T00:00:00.000Z',changes:{'10':[fact('b','changed')]},omitted:['10:c']},
  {version:'c2',reviewedAt:'2026-01-11T00:00:00.000Z',expiresAt:'2026-01-18T00:00:00.000Z'},
 ],problems)
 eq(problems,[])
 eq(out.map(r=>[r.version,r.reviewedAt,r.facts.map(f=>`${f.key}=${f.summary}`)]),[['c1','2026-01-06T00:00:00.000Z',['a=a','b=changed']],['c2','2026-01-11T00:00:00.000Z',['a=a','b=changed']]])
 eq(seed.flatMap(r=>r.facts.map(f=>f.summary)),['a','b','c'])
 const cycle={version:'late',reviewedAt:'2026-01-10T00:00:00.000Z',expiresAt:'2026-01-17T00:00:00.000Z'},late:string[]=[]
 reviewCycleRestatements(seed,[cycle],late)
 eq(late,['late: 10:a expired before this review','late: 10:b expired before this review','late: 10:c expired before this review'])
 const noted:string[]=[];reviewCycleRestatements(seed,[{...cycle,lapse:'Deploy credentials were unavailable'}],noted);eq(noted,[])
 const bad:string[]=[]
 reviewCycleRestatements(seed,[{version:'bad',reviewedAt:'2026-01-02T00:00:00.000Z',expiresAt:'2026-01-08T00:00:00.000Z',omitted:['10:z','99:a','x'],changes:{'99':[fact('a')]}}],bad)
 eq(bad,['bad: review date must follow every earlier review','bad: window must be seven days','bad: omits unknown fact 10:z','bad: omits unknown fact 99:a','bad: omits unknown fact x','bad: changes unknown token 99'])
})

Deno.test('scheduled issuer cycles restate every current fact under one date and leave no gap',async()=>{
 const problems:string[]=[];reviewCycleRestatements(ISSUER_REVIEW_SEED,ISSUER_REVIEW_CYCLES,problems);eq(problems,[])
 for(const cycle of ISSUER_REVIEW_CYCLES)eq(Date.parse(cycle.expiresAt)-Date.parse(cycle.reviewedAt),ISSUER_REVIEW_WINDOW_MS)
 const cycle=ISSUER_REVIEW_CYCLES[0],start=Date.parse(cycle.reviewedAt)
 const before=await issuerReviewObservations([gold,ondo],iso(start-1)),after=await issuerReviewObservations([gold,ondo],iso(start))
 const key=(o:{metric:string;metadata?:Record<string,unknown>})=>`${o.metadata?.cryptoId}:${o.metric.slice('issuer_'.length)}`
 const restated=after.filter(o=>o.metadata?.reviewVersion===cycle.version),omitted=new Set(cycle.omitted??[])
 eq(before.filter(o=>o.metadata?.reviewVersion===cycle.version),[])
 eq([...new Set(before.map(key))].filter(k=>!omitted.has(k)&&!restated.some(o=>key(o)===k)),[])
 assert(restated.every(o=>o.observedAt===cycle.reviewedAt&&o.expiresAt===cycle.expiresAt&&o.aiAllowed===false&&o.exportAllowed===true))
 // Earlier versions keep their original words and review clock.
 const original=before.find(o=>o.metadata?.cryptoId==='4705'&&o.metric==='issuer_redemption')!
 eq(original.observedAt,ISSUER_REVIEWED_AT);assert(String(original.value).includes('completion can take several business days'))
 assert(String(restated.find(o=>key(o)==='4705:redemption')?.value).includes('no delivery completion time is stated'))
 assert(restated.some(o=>key(o)==='38093:off_hours'))
 const observations=[...before,...after]
 for(const [subject,cryptoId] of [['rwa:coinmarketcap:1','4705'],['rwa:coinmarketcap:2','38093'],['rwa:coinmarketcap:1','5176'],['rwa:coinmarketcap:1','34212'],['rwa:coinmarketcap:1','20245']]) {
  const review=issuerReviewAt(observations,subject,cryptoId,seedExpired)
  eq(review.state,'reviewed');assert(review.facts.every(o=>o.observedAt===cycle.reviewedAt))
  eq(issuerReviewAt(observations,subject,cryptoId,Date.parse(cycle.expiresAt)).state,'review_expired')
 }
 eq(issuerReviewAt(observations,'rwa:coinmarketcap:2','38093',seedExpired).schedule,'ondo_conventional_1')
})

Deno.test('a review cycle keeps terms arithmetic available after the seed reviews expire',async()=>{
 const cycle=ISSUER_REVIEW_CYCLES[0],subject='rwa:coinmarketcap:1'
 const observations=[...await issuerReviewObservations([gold,ondo],'2026-09-12T22:13:17.000Z'),...await issuerReviewObservations([gold,ondo],cycle.reviewedAt)]
 const paxg=rwaTermsProjection(observations,subject,'4705',seedExpired,430)
 eq(paxg.state,'reviewed');eq(paxg.underlyingUnits,430);eq(paxg.redemption?.threshold?.meetsQuantity,true)
 eq(rwaTermsProjection(observations,subject,'20245',seedExpired,2).underlyingUnits,2)
 eq(rwaTermsProjection(observations,'rwa:coinmarketcap:2','38093',seedExpired,5).underlyingUnits,null)
 eq(rwaTermsProjection(observations,subject,'4705',Date.parse(cycle.expiresAt),430).underlyingUnits,null)
})
