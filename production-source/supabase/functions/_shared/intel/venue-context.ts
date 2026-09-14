import {currentFragility} from './fragility-history.ts'
import {evidenceAt,observationState,finite,type Observation} from './investigation-evidence.ts'
/** Venue selection never changes the captured population or manufactures an
 * asset/venue intersection from separate aggregate liquidation totals. */
export function venueContext(observations:Observation[],subject:string,at:number,venueId:string|null=null){
 const result=currentFragility(observations,subject,at)
 const choices=[...new Map(observations.filter(o=>o.subject===subject&&o.metric==='open_interest'&&o.metadata?.venueId&&Date.parse(o.recordedAt)<=at).map(o=>[String(o.metadata!.venueId),{id:String(o.metadata!.venueId),name:String(o.metadata!.venue||o.metadata!.venueId)}])).values()].sort((a,b)=>a.name.localeCompare(b.name))
 const venues=venueId?result.venues.filter(v=>v.id===venueId):result.venues
 const contracts=venues.flatMap(v=>v.contracts.map(c=>({...c,shareOfCoveredAssetPercent:v.sharePercent})))
 const fundingGroups=new Map<number,{periodSeconds:number;contracts:number;openInterestUsd:number;weightedSum:number}>()
 let fundingUnknown=0
 for(const v of venues)for(const f of v.funding){
  const weight=v.contracts.find(c=>c.id===f.contractId)?.openInterestUsd
  if(result.batchComplete!==true||!f.comparable||f.ratePercent==null||f.periodSeconds==null||weight==null){fundingUnknown++;continue}
  const group=fundingGroups.get(f.periodSeconds)||{periodSeconds:f.periodSeconds,contracts:0,openInterestUsd:0,weightedSum:0}
  group.contracts++;group.openInterestUsd+=weight;group.weightedSum+=f.ratePercent*weight;fundingGroups.set(f.periodSeconds,group)
 }
 const current=evidenceAt(observations.filter(o=>o.subject===subject&&/^liquidations_(1h|4h|24h)$/.test(o.metric)),at)
 const liquidations=current.filter(o=>(!venueId||String(o.metadata?.venueId||'')===venueId)&&o.unit==='USD'&&observationState(o,at)==='known'&&finite(o.value)!=null&&Number(o.value)>=0)
 return {subject,at,venueId,choices,result,venues,contracts,totalOpenInterestUsd:contracts.length?contracts.reduce((sum,c)=>sum+c.openInterestUsd!,0):null,
  funding:[...fundingGroups.values()].map(g=>({...g,ratePercent:g.openInterestUsd>0?g.weightedSum/g.openInterestUsd:null})),fundingUnknown,liquidations,
  liquidationReason:venueId&&!liquidations.length?'No fresh asset-and-venue liquidation observation is available. Asset totals cannot be assigned to the selected venue.':!liquidations.length?'No fresh compatible liquidation window is available.':null,
  coverage:result.coverage+' '+(result.coverageNote||'')+' Funding averages are weighted by covered open interest only within the same confirmed interval; unknown units or intervals are excluded. No annualization is inferred.'}
}
