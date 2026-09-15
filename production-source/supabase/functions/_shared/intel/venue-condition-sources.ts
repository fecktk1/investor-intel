import {finite,instant,observationState,type Observation} from './investigation-evidence.ts'
import {conditionSource,conditionMaxAgeSeconds,matchesConditionSource,HISTORY_CONDITION_METRICS,REGIME_CONDITION_METRICS,REGIME_SUBJECT} from './condition-source.ts'
/** Types only: the conditions layer must not pull the provider transport in. */
import type {AssetHistory} from './asset-history.ts'
import type {DistanceFromHigh,Drawdown,Volatility} from './risk-metrics.ts'
export interface HistoryRiskMetrics {volatility30d:Volatility|null;maxDrawdown:Drawdown|null;distanceFromHigh:DistanceFromHigh|null;timeUnderWaterDays:number|null}
const CONDITION_LABELS:Record<string,string>={
 realized_volatility_30d:'CMC · 30-day realised volatility',drawdown_pct:'CMC · Drawdown from high',days_since_high:'CMC · Days since high',
 regime_fear_greed:'CMC · Fear and greed',regime_altcoin_season:'CMC · Altcoin season index',regime_btc_dominance:'CMC · BTC dominance',
}
const HISTORY_TTL_MS=3600000
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
/** Derived history measures as observations, so the existing evaluator can use
 * them unchanged once a caller supplies them. The measures describe the window
 * that was actually loaded: observedAt is the newest point of that series, the
 * record is known from now, and it expires with the history cache after an hour.
 * Nothing here calls a provider or reads a table. */
export function historyConditionObservations(history:AssetHistory|null|undefined,metrics:HistoryRiskMetrics|null|undefined,subject:string,now:number):Observation[]{
 if(!history||history.state==='unavailable'||!Array.isArray(history.points)||!history.points.length)return []
 if(!/^market:coinmarketcap:[1-9][0-9]{0,9}$/.test(String(subject))||!Number.isFinite(now))return []
 const newest=instant(history.observedAt)??finite(history.points[history.points.length-1]?.t)
 if(newest==null||newest>now)return []
 const observedAt=new Date(newest).toISOString(),recordedAt=new Date(now).toISOString(),expiresAt=new Date(now+HISTORY_TTL_MS).toISOString()
 const volatility=metrics?.volatility30d??null,drawdown=metrics?.maxDrawdown??null,high=metrics?.distanceFromHigh??null
 const window={interval:history.interval,points:history.points.length,
  coverage:'Derived from the loaded history window only; a longer window can contain a deeper decline or an older high.'}
 const candidates:[string,unknown,Record<string,unknown>][]=[
  ['realized_volatility_30d',volatility?.pct,{derivation:'Annualised standard deviation of log returns at the series sampling interval',
   samples:volatility?.samples??null,windowDays:volatility?.windowDays??null,intervalSeconds:volatility?.intervalSeconds??null}],
  ['drawdown_pct',drawdown?.pct,{derivation:'Deepest peak-to-trough decline in the window, as a signed percentage of the peak',
   peakT:drawdown?.peakT??null,troughT:drawdown?.troughT??null,recoveredT:drawdown?.recoveredT??null}],
  ['days_since_high',high?.daysSince,{derivation:'Days since the highest close of the window was last reached',highT:high?.highT??null}],
 ]
 const projected:Observation[]=[]
 for(const [metric,value,metadata] of candidates){
  const v=finite(value);if(v==null)continue
  projected.push({id:`history:${subject}:${metric}:${observedAt}`,subject,metric,value:v,unit:HISTORY_CONDITION_METRICS[metric].unit,
   periodSeconds:HISTORY_CONDITION_METRICS[metric].periodSeconds,provider:'coinmarketcap',
   sourceRef:`coinmarketcap:/v3/cryptocurrency/quotes/historical:${history.interval}:${subject}`,
   sourceUrl:'https://coinmarketcap.com/api/documentation/pro-api-reference/endpoint-overview',
   observedAt,recordedAt,expiresAt,universe:`history:${history.interval}`,aiAllowed:true,exportAllowed:false,metadata:{...window,...metadata}})
 }
 return projected
}
/** One captured market-regime row as observations. The subject is the market,
 * never an asset, so a regime condition cannot be read as asset-specific data. */
export function regimeConditionObservations(row:any,now:number):Observation[]{
 if(!row||!Number.isFinite(now))return []
 const provider=typeof row.provider==='string'&&row.provider?row.provider:'coinmarketcap'
 const observed=instant(row.source_observed_at??row.captured_at)
 if(observed==null||observed>now)return []
 const observedAt=new Date(observed).toISOString(),recordedAt=new Date(now).toISOString(),expiresAt=new Date(now+HISTORY_TTL_MS).toISOString()
 const projected:Observation[]=[]
 for(const [column,metric] of [['fear_greed_value','regime_fear_greed'],['altcoin_season_index','regime_altcoin_season'],['btc_dominance','regime_btc_dominance']] as const){
  const v=finite(row[column]);if(v==null)continue
  projected.push({id:`regime:${provider}:${metric}:${observedAt}`,subject:REGIME_SUBJECT,metric,value:v,unit:REGIME_CONDITION_METRICS[metric].unit,periodSeconds:null,
   provider,sourceRef:`intel_regime_snapshots:${provider}:${observedAt}`,observedAt,recordedAt,expiresAt,universe:'cmc:regime',aiAllowed:true,exportAllowed:false,
   metadata:{fearGreedClass:typeof row.fear_greed_class==='string'?row.fear_greed_class:null,capturedAt:instant(row.captured_at)!=null?new Date(instant(row.captured_at)!).toISOString():null,
    coverage:'Provider market-wide regime reading; it describes the market, not this asset.'}})
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
  const named=Object.hasOwn(CONDITION_LABELS,o.metric)?CONDITION_LABELS[o.metric]:null
  const label=named||(o.metric==='holder_count'?'CMC · Daily holder accounts':o.metric==='liquidity_event_usd'?'CMC · Latest reported pool liquidity event':`${venue||'Covered asset'}${contract?' · '+contract:''}${o.metadata?.pair?' · '+o.metadata.pair+' · '+o.metadata.side:''} · ${o.metric.replaceAll('_',' ')}`)
  unique.set(key,{key,sourceMetric:source,metric:o.metric,unit:o.unit,periodSeconds:o.periodSeconds??null,label:`${label} (${o.unit}${o.periodSeconds?' / '+o.periodSeconds+'s':''})`,observation:o})
 }
 return [...unique.values()].sort((a,b)=>a.label.localeCompare(b.label)).slice(0,100)
}
