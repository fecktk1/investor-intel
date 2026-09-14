import {evidenceAt,instant,stableJson,type Observation} from './investigation-evidence.ts'
import {marketFragility,type VenueObservation} from './investigation-calculations.ts'

export function derivativeVenueObservation(o:Observation):VenueObservation & {observation:Observation} {
 return {id:String(o.metadata?.contractId||''),subject:o.subject,venueId:String(o.metadata?.venueId||''),venue:String(o.metadata?.venue||'Unknown venue'),
  observedAt:o.observedAt,expiresAt:o.expiresAt,openInterestUsd:typeof o.value==='number'?o.value:null,quoteCurrency:o.unit,
  compatibleQuote:o.metadata?.compatibleQuote===true,excluded:o.metadata?.excluded===true||(o.state!=null&&o.state!=='known'),sourceRef:o.sourceRef,
  fundingRatePercent:typeof o.metadata?.fundingRateRaw==='number'?o.metadata.fundingRateRaw:typeof o.metadata?.fundingRatePercent==='number'?o.metadata.fundingRatePercent:null,
  fundingUnit:o.metadata?.fundingUnit==='percent'||o.metadata?.fundingUnit==='ratio'||o.metadata?.fundingUnit==='unknown'?o.metadata.fundingUnit:o.provider!=='coinmarketcap'&&typeof o.metadata?.fundingRatePercent==='number'?'percent':'unknown',
  fundingPeriodSeconds:typeof o.metadata?.fundingPeriodSeconds==='number'?o.metadata.fundingPeriodSeconds:null,observation:o}
}
/** Only recorded response batches can establish historical concentration. No
 * interpolated snapshots, carried-forward contracts, or current-membership backfill. */
export function fragilityHistory(observations:Observation[],subject:string,from:number,at:number) {
 if(!Number.isFinite(from)||!Number.isFinite(at)||from>at)throw new Error('invalid_fragility_range')
 const groups=new Map<string,Observation[]>(),legacyIds=new Set<string>()
 for(const o of observations.slice(0,10000)) {
  const observed=instant(o.observedAt),recorded=instant(o.recordedAt)
  if(o.subject!==subject||o.metric!=='open_interest'||observed==null||recorded==null||observed<from||observed>at||recorded>at)continue
  const batch=o.metadata?.batchId
  if(typeof batch!=='string'||!/^[a-f0-9]{64}$/.test(batch)){legacyIds.add(o.id);continue}
  const key=`${o.provider}:${o.sourceRef}:${batch}`,items=groups.get(key)||[];items.push(o);groups.set(key,items)
 }
 const rows=[...groups.entries()].map(([id,items])=>{
  // Equivalent normalization versions may have different IDs for the same
  // original contract fact. Keep its earliest recorded representation; a
  // conflicting economic value remains distinct and invalidates batch completeness.
  const factKey=(o:Observation)=>{const v=derivativeVenueObservation(o);return stableJson({venue:v.venueId,contract:v.id,observedAt:v.observedAt,value:v.openInterestUsd,unit:v.quoteCurrency,compatible:v.compatibleQuote,excluded:v.excluded,funding:v.fundingRatePercent,period:v.fundingPeriodSeconds,fundingUnit:v.fundingUnit})}
  const unique=[...new Map([...items].sort((a,b)=>instant(b.recordedAt)!-instant(a.recordedAt)!||b.id.localeCompare(a.id)).map(o=>[factKey(o),o])).values()]
  const observedAt=Math.max(...unique.map(o=>instant(o.observedAt)!)),knownAt=Math.max(observedAt,...unique.map(o=>instant(o.recordedAt)!))
  const counts=new Set(unique.map(o=>o.metadata?.batchContractCount)),expected=[...counts][0]
  const complete=counts.size===1&&typeof expected==='number'&&Number.isSafeInteger(expected)&&expected>0&&expected===unique.length
  const result=marketFragility(unique.map(derivativeVenueObservation),subject,knownAt)
  const contractSet=result.venues.flatMap(v=>v.contracts.map(c=>`${v.id}:${c.id}`)).sort()
  const population=stableJson({provider:unique[0].provider,sourceRef:unique[0].sourceRef,contractSet})
  return {id,observedAt,knownAt,complete,expectedContracts:typeof expected==='number'?expected:null,receivedContracts:unique.length,
   result,population,observations:unique,hasMore:unique[0].metadata?.batchHasMore??null,
   concentrationHhi:complete&&result.totalOpenInterestUsd!=null&&result.totalOpenInterestUsd>0?result.venues.reduce((sum,v)=>sum+((v.sharePercent??0)/100)**2,0):null,
   largestVenueShare:complete?result.largestVenueShare:null,totalOpenInterestUsd:complete?result.totalOpenInterestUsd:null,
   largestVenueShareChange:null as number|null,openInterestChangePercent:null as number|null,
   comparisonReason:complete?'A prior comparable snapshot is needed.':'This response batch is incomplete in the loaded history. Load earlier evidence to recover its missing contracts.'}
 }).sort((a,b)=>a.observedAt-b.observedAt||a.knownAt-b.knownAt||a.id.localeCompare(b.id))
 for(let i=1;i<rows.length;i++) {
  const current=rows[i],previous=rows[i-1]
  const same=current.complete&&previous.complete&&current.population===previous.population&&current.result.coveredContracts>0&&
   current.observedAt>previous.observedAt&&current.knownAt>=previous.knownAt&&current.hasMore===previous.hasMore
  if(same&&current.largestVenueShare!=null&&previous.largestVenueShare!=null&&current.totalOpenInterestUsd!=null&&previous.totalOpenInterestUsd!>0) {
   current.largestVenueShareChange=current.largestVenueShare-previous.largestVenueShare
   current.openInterestChangePercent=(current.totalOpenInterestUsd/previous.totalOpenInterestUsd!-1)*100
   current.comparisonReason='Same covered contract set and source query; this is not whole-market coverage.'
  }else if(current.complete)current.comparisonReason=!previous.complete?'The preceding loaded snapshot is incomplete.':current.population!==previous.population?'The covered contract set changed. A concentration or OI delta would use different populations.':'Observation times or source coverage are not comparable.'
 }
 const visible=rows.slice(-120)
 return {rows:visible,totalSnapshots:rows.length,omittedSnapshots:rows.length-visible.length,legacyObservations:legacyIds.size,inputTruncated:observations.length>10000,
  coverage:'Each point uses one recorded provider response and time-aligned USD contracts. Concentration changes require the same covered contract set. Missing batches have no implied value; legacy observations without response membership cannot reconstruct this history.'}
}

/** Current concentration uses a single response population. Contracts absent from
 * the latest batch must never be carried forward from an older response. */
export function currentFragility(observations:Observation[],subject:string,at:number){
 const history=fragilityHistory(observations,subject,0,at)
 const latest=[...history.rows].sort((a,b)=>b.knownAt-a.knownAt||b.observedAt-a.observedAt||b.id.localeCompare(a.id))[0]
 if(!latest){
  const legacy=evidenceAt(observations.filter(o=>o.subject===subject&&o.metric==='open_interest'),at)
  return {...marketFragility(legacy.map(derivativeVenueObservation),subject,at),batchKnownAt:null,batchComplete:null,expectedContracts:null,coverageNote:legacy.length?'Legacy observations lack response membership; this view cannot verify a single provider population.':null}
 }
 const result=marketFragility(latest.observations.map(derivativeVenueObservation),subject,at)
 return {...result,...(!latest.complete?{venues:[],totalOpenInterestUsd:null,largestVenueShare:null,coveredContracts:0}:{}),batchKnownAt:latest.knownAt,batchComplete:latest.complete,expectedContracts:latest.expectedContracts,
  coverageNote:latest.complete?'One recorded response population; contracts missing from this batch are not carried forward.':'The latest recorded response is incomplete in the loaded history. Load available history or select another batch before using its concentration.'}
}
