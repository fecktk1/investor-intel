import {finite,instant} from './investigation-evidence.ts'
import {representationReview} from './representation-review.ts'
/** Values come from authorized selected-portfolio accounting, never source
 * market caps or a new token-price computation. No cross-portfolio aggregation. */
export function rwaPortfolioExposure(holdings:any[],evidence:any[],totalValue:number|null,now:number){
 const rows:any[]=[],unmapped:string[]=[],failed:string[]=[],ambiguous:string[]=[]
 for(const holding of holdings){
  const key=holding.canonicalAssetKey;if(!key)continue
  const context=evidence.find(e=>e.canonicalAssetKey===key),state=context?.rwa_state
  if(state?.status==='error'){failed.push(key);continue}
  const market=context?.connected_identity?.marketSubject
  const versions=(state?.versions||[]).filter((v:any)=>v.subject===market&&v.family==='rwa_relationship'&&instant(v.recordedAt)!=null&&instant(v.recordedAt)!<=now&&instant(v.fetchedAt)!=null&&instant(v.fetchedAt)!<=now).sort((a:any,b:any)=>Date.parse(b.fetchedAt)-Date.parse(a.fetchedAt))
  if(!versions.length){unmapped.push(key);continue}
  const latest=versions[0],doc=latest.document
  if(!doc?.issuerId||!doc?.rwaId||market!==`market:coinmarketcap:${doc.cryptoId}`||versions.some((v:any)=>v.fetchedAt===latest.fetchedAt&&(v.document?.issuerId!==doc.issuerId||v.document?.rwaId!==doc.rwaId))){ambiguous.push(key);continue}
  const value=finite(holding.value)
  rows.push({canonicalAssetKey:key,name:holding.name||holding.symbol||doc.tokenName,quantity:finite(holding.quantity),valueUsd:value,priceStatus:holding.priceStatus,positionObservedAt:holding.observedAt??null,
   portfolioAllocationPct:value!=null&&totalValue!=null&&totalValue>0?value/totalValue*100:null,rwaId:doc.rwaId,underlyingName:doc.underlyingName,issuerId:doc.issuerId,issuerName:doc.issuerName,cryptoId:doc.cryptoId,
   relationshipStatus:instant(latest.expiresAt)!=null&&instant(latest.expiresAt)!>now?'fresh':'stale',relationshipVersion:latest,representationReview:representationReview(key,now)})
 }
 const groups=new Map<string,any>()
 for(const row of rows){const key=`${row.rwaId}:${row.issuerId}`,g=groups.get(key)||{rwaId:row.rwaId,underlyingName:row.underlyingName,issuerId:row.issuerId,issuerName:row.issuerName,pricedSubtotalUsd:0,unpriced:0,positions:0};g.positions++;if(row.valueUsd==null)g.unpriced++;else g.pricedSubtotalUsd+=row.valueUsd;groups.set(key,g)}
 return {status:failed.length?'partial':rows.length?'available':'missing',rows,groups:[...groups.values()],failed,unmapped,ambiguous,totalValue,
  method:'Exact CMC token/underlying/issuer relationships joined to the selected portfolio ledger. Priced subtotals are token position values, not underlying NAV or redemption value. Quantities are never summed across token representations. Unmapped positions are unclassified, not non-RWA.'}
}
