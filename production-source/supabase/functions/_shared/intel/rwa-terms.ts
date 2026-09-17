import {finite,observationState,type Observation} from './investigation-evidence.ts'
import {issuerReviewAt} from './rwa-issuer-evidence.ts'
/** Unit arithmetic only, with exact reviewed token/issuer identity. Never a
 * valuation, NAV, eligibility decision, live quote or automatic wallet read.
 *
 * The `review_expired` state here inherits its meaning from the issuer reviews:
 * it means every structured term was EXPLICITLY WITHDRAWN by a later review.
 * Reviewed terms carry a null expiry, so elapsed time never suppresses the
 * arithmetic. See _shared/intel/rwa-issuer-evidence.ts. */
export function rwaTermsProjection(observations:Observation[],subject:string,cryptoId:string,at:number,quantity:unknown){
 const review=issuerReviewAt(observations,subject,cryptoId,at),facts=review.facts.filter(o=>o.metadata?.terms)
 const valid=facts.filter(o=>observationState(o,at)==='known'),denomination=valid.find(o=>(o.metadata?.terms as any)?.kind==='denomination'),redemption=valid.find(o=>(o.metadata?.terms as any)?.kind==='redemption')
 const d=denomination?.metadata?.terms as any,r=redemption?.metadata?.terms as any,q=(typeof quantity==='number'||(typeof quantity==='string'&&quantity.trim()!==''))?finite(quantity):null
 const units=q!=null&&q>=0&&finite(d?.unitsPerToken)!=null&&d.unitsPerToken>0&&!d.variable?q*d.unitsPerToken:null
 const threshold=q!=null&&q>=0&&r?.minimumUnit==='token'&&finite(r.minimum)!=null&&r.minimum>=0?{minimum:r.minimum,unit:r.minimumUnit,shortfall:Math.max(0,r.minimum-q),meetsQuantity:q>=r.minimum}:null
 return {state:valid.length?'reviewed':facts.length?'review_expired':'unavailable',facts,quantity:q!=null&&q>=0?q:null,
  denomination:denomination?{observationId:denomination.id,unitsPerToken:d.unitsPerToken,underlyingUnit:d.underlyingUnit,variable:d.variable}:null,
  underlyingUnits:units!=null&&Number.isFinite(units)&&units<=Number.MAX_SAFE_INTEGER?units:null,
  redemption:redemption?{...r,observationId:redemption.id,threshold}:null}
}
