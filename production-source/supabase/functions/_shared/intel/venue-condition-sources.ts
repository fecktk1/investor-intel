import {finite,instant,observationState,type Observation} from './investigation-evidence.ts'
import {conditionSource,conditionMaxAgeSeconds,matchesConditionSource} from './condition-source.ts'
/** Deterministic projections of already-authorized records, keeping source IDs.
 * Funding requires an explicit unit/period; best-level depth is not an order. */
export function venueConditionObservations(observations:Observation[],depth:any,now:number):Observation[]{
 const projected:Observation[]=[]
 for(const o of observations.slice(0,10000)){
  if(o.metric!=='open_interest'||o.metadata?.compatibleQuote!==true||o.metadata?.excluded===true||observationState(o,now)!=='known')continue
  const m=o.metadata||{},unit=m.fundingUnit??(o.provider!=='coinmarketcap'&&typeof m.fundingRatePercent==='number'?'percent':'unknown'),period=finite(m.fundingPeriodSeconds),raw=finite(m.fundingRateRaw??m.fundingRatePercent)
  if(typeof unit!=='string'||!['percent','ratio'].includes(unit)||raw==null||period==null||!Number.isSafeInteger(period)||period<=0||period>604800)continue
  projected.push({...o,id:o.id+':funding',metric:'funding_rate',value:unit==='ratio'?raw*100:raw,unit:'%',periodSeconds:period,metadata:{...m,originalObservationId:o.id,derivation:'explicit_funding_unit_conversion'}})
 }
 for(const d of (Array.isArray(depth?.quotes)?depth.quotes:[]).slice(0,16)){
  const observed=instant(d.observedAt),expires=instant(d.expiresAt),price=finite(d.levels?.[0]?.price),quantity=finite(d.levels?.[0]?.quantity)
  if(depth.status==='error'||d.currency!=='USD'||d.verifiedQuote!==true||d.levels?.length!==1||observed==null||observed>now||now-observed>60000||expires==null||expires<=now||price==null||price<=0||quantity==null||quantity<0||!Number.isFinite(price*quantity))continue
  const known=instant(d.recordedAt)
  // Historical evaluation needs the original known-at clock. If absent, depth
  // remains visible on the page but cannot become an alert source.
  if(known==null||known>now)continue
  projected.push({id:'depth:'+d.sourceRef+':'+d.side,subject:d.subject,metric:'depth_notional',value:price*quantity,unit:'USD',periodSeconds:null,provider:d.venue,sourceRef:d.sourceRef,observedAt:d.observedAt,recordedAt:d.recordedAt,expiresAt:d.expiresAt,universe:`${d.venue}:${d.pair}:${d.side}`,aiAllowed:true,exportAllowed:false,metadata:{venue:d.venue,pair:d.pair,side:d.side,coverage:'Recorded best price times available quantity. Deeper levels and fees are unknown; no execution is inferred.'}})
 }
 return projected
}
export function venueConditionChoices(observations:Observation[],depth:any,now:number){
 const all=[...observations,...venueConditionObservations(observations,depth,now)].filter(o=>conditionSource(o)&&o.expiresAt!=null&&observationState(o,now,conditionMaxAgeSeconds(o.metric))==='known')
 const unique=new Map<string,any>()
 for(const o of all){const source=conditionSource(o)!,key=[source,o.metric,o.unit,o.periodSeconds??'current'].join('|');if(source.length>80)continue
  if(o.metric==='open_interest'&&(o.metadata?.compatibleQuote!==true||o.metadata?.excluded===true||o.unit!=='USD'||finite(o.value)==null||Number(o.value)<0))continue
  if(!matchesConditionSource(o,source,o.metric))continue
  const before=unique.get(key);if(before&&(instant(before.observation.observedAt)??0)>=(instant(o.observedAt)??0))continue
  const venue=o.metadata?.venue||o.metadata?.venueId,contract=o.metadata?.contractId
  const label=o.metric==='holder_count'?'CMC · Daily holder accounts':o.metric==='liquidity_event_usd'?'CMC · Latest reported pool liquidity event':`${venue||'Covered asset'}${contract?' · '+contract:''}${o.metadata?.pair?' · '+o.metadata.pair+' · '+o.metadata.side:''} · ${o.metric.replaceAll('_',' ')}`
  unique.set(key,{key,sourceMetric:source,metric:o.metric,unit:o.unit,periodSeconds:o.periodSeconds??null,label:`${label} (${o.unit}${o.periodSeconds?' / '+o.periodSeconds+'s':''})`,observation:o})
 }
 return [...unique.values()].sort((a,b)=>a.label.localeCompare(b.label)).slice(0,100)
}
