import {assert,assertEquals as eq} from 'https://deno.land/std@0.224.0/assert/mod.ts'
import {issuerReviewObservations,issuerReviewAt,STRUCTURED_TERMS_REVIEWED_AT} from './rwa-issuer-evidence.ts'
import {rwaTermsProjection} from './rwa-terms.ts'
const at=Date.parse(STRUCTURED_TERMS_REVIEWED_AT)+1000,subject='rwa:coinmarketcap:1',records=[{rwa_id:1,tokens:[{crypto_id:4705,issuer_id:'68904c24abae9b5b9fb35815'},{crypto_id:20245,issuer_id:'68904cceabae9b5b9fb35839'}]},{rwa_id:2,tokens:[{crypto_id:38093,issuer_id:'688ca4ccabae9b5b9fb3167a'}]}]
Deno.test('independent issuer facts keep their original clocks and support zero denomination arithmetic',async()=>{
 const facts=await issuerReviewObservations(records,new Date(at).toISOString()),review=issuerReviewAt(facts,subject,'4705',at)
 eq(review.state,'reviewed');eq(new Set(review.facts.map(o=>o.observedAt)).size,2)
 const zero=rwaTermsProjection(facts,subject,'4705',at,0);eq(zero.underlyingUnits,0);eq(zero.redemption?.threshold?.shortfall,430)
 const enough=rwaTermsProjection(facts,subject,'4705',at,430);eq(enough.underlyingUnits,430);eq(enough.redemption?.threshold?.meetsQuantity,true);eq(enough.redemption?.availability,'unverified');eq(enough.redemption?.feesIncluded,false)
})
Deno.test('token/USD/share/gram units stay distinct and illustrative multipliers cannot become live facts',async()=>{
 const facts=await issuerReviewObservations(records,new Date(at).toISOString()),ondo=rwaTermsProjection(facts,'rwa:coinmarketcap:2','38093',at,1e6)
 eq(ondo.underlyingUnits,null);eq(ondo.denomination?.unitsPerToken,null);eq(ondo.redemption?.threshold,null);eq(ondo.redemption?.minimumUnit,'USD')
 eq(rwaTermsProjection(facts,subject,'20245',at,2).denomination?.underlyingUnit,'gram_gold_minimum_999_purity')
 eq(rwaTermsProjection(facts,subject,'20245',at,2).underlyingUnits,2)
})
Deno.test('reviewed terms stay calculable however long ago they were read',async()=>{
 const facts=await issuerReviewObservations(records,new Date(at).toISOString())
 // Eight days, then seven years. A structured term does not rot.
 for(const later of [Date.parse('2026-09-20T00:00Z'),Date.parse('2033-06-01T00:00Z')]) {
  const projection=rwaTermsProjection(facts,subject,'4705',later,430)
  eq(projection.state,'reviewed');eq(projection.underlyingUnits,430);eq(projection.redemption?.threshold?.meetsQuantity,true)
 }
 // A withdrawn term, and only a withdrawn one, stops the arithmetic.
 const withdrawn=facts.filter(o=>o.metadata?.terms).map(o=>({...o,id:`${o.id}:w`,observedAt:'2026-09-20T00:00:00.000Z',state:'stale' as const,reason:'withdrawn'}))
 const gone=rwaTermsProjection([...facts,...withdrawn],subject,'4705',Date.parse('2033-06-01T00:00Z'),430)
 eq(gone.state,'review_expired');eq(gone.underlyingUnits,null)
})
Deno.test('rewind, conflicting issuer identities and malformed quantities suppress arithmetic',async()=>{
 const facts=await issuerReviewObservations(records,new Date(at).toISOString())
 eq(rwaTermsProjection(facts,subject,'4705',at-2000,430).underlyingUnits,null)
 for(const quantity of [-1,null,'','  ',[],{},NaN,Infinity])eq(rwaTermsProjection(facts,subject,'4705',at,quantity).underlyingUnits,null)
 const current=facts.find(o=>o.metadata?.cryptoId==='4705')!
 eq(rwaTermsProjection([...facts,{...current,id:'conflict',universe:'different',metadata:{...current.metadata,issuerId:'other'}}],subject,'4705',at,430).underlyingUnits,null)
 assert(facts.every(o=>o.aiAllowed===false&&o.exportAllowed===true))
})
