import {finite,instant,digest,stableJson,type Observation} from './investigation-evidence.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
type Row=Record<string,any>
const safe=(v:unknown)=>{if(typeof v!=='number'&&(typeof v!=='string'||v.trim()===''))return null;const n=finite(v);return n!=null&&Math.abs(n)<=Number.MAX_SAFE_INTEGER/100?n:null}
export const CASHFLOW_BENCHMARK_METHOD='exact-flow-index-comparison-1'
export const CASHFLOW_BENCHMARK_NOTE='Comparison of the recorded asset book with a hypothetical CMC index position receiving the same recorded capital movements. Each period starts with that period’s recorded opening value. Every valuation and nonzero movement requires an index observation at the identical timestamp; no interpolation or nearby quote is used. Both returns use the same Modified Dietz capital denominator. This is an index-level research comparison, not an investable product, exact time-weighted return, or allocation/selection attribution. Index fees and trading costs are not modeled.'

/** No clock rounding, identity inference, provider request, or ledger mutation. */
export function cashflowBenchmark(performance:Row,observations:Observation[],index:'100'|'20',now=Date.now()){
 const subject=`index:coinmarketcap:${index}`,times=new Map<number,Observation|null>(),used=new Map<string,Observation>()
 for(const o of observations){
  const at=instant(o.observedAt),known=instant(o.recordedAt),value=safe(o.value)
  if(o.subject!==subject||o.provider!=='coinmarketcap'||o.metric!=='index_level'||o.unit!=='index_points'||o.aiAllowed!==true||at==null||known==null||at>now||known>now||value==null||value<0)continue
  const previous=times.get(at)
  if(times.has(at)&&(!previous||Number(previous.value)!==value)){times.set(at,null);continue}
  if(!previous||known>instant(previous.recordedAt)!)times.set(at,o)
 }
 const periods=(performance.periods||[]).map((p:Row)=>{
  const row={from:p.from,to:p.to,snapshotIds:p.snapshotIds,flows:p.flows||[],status:'unavailable',reason:'portfolio_period_unavailable',benchmarkEndValueUsd:null as number|null,benchmarkReturnPercent:null as number|null,portfolioReturnPercent:p.returnPercent??null,differencePercentagePoints:null as number|null,excessChangeUsd:null as number|null,observationIds:[] as string[]}
  const from=instant(p.from),to=instant(p.to),capital=safe(p.weightedCapitalUsd),opening=safe(p.startValueUsd),closing=safe(p.endValueUsd)
  if(p.status!=='estimate'||from==null||to==null||to<=from||opening==null||opening<0||closing==null||capital==null||capital<=0||safe(p.returnPercent)==null)return row
  const facts:Observation[]=[],factAt=(at:number)=>{const o=times.get(at);if(o)facts.push(o);return o?safe(o.value):null}
  const first=factAt(from),last=factAt(to)
  if(first==null||last==null||first<=0)return {...row,reason:'exact_index_observation_missing'}
  let units=opening/first,net=0
  const flows=[...row.flows].sort((a,b)=>(instant(a.at)??Infinity)-(instant(b.at)??Infinity))
  for(const f of flows){
   const at=instant(f.at),amount=safe(f.valueUsd)
   if(at==null||at<=from||at>to||amount==null)return {...row,reason:'invalid_flow_input'}
   if(amount===0)continue
   const level=factAt(at)
   if(level==null||level<=0)return {...row,reason:'exact_flow_index_observation_missing'}
   units+=amount/level;net+=amount
   if(!Number.isFinite(units)||units < -1e-10)return {...row,reason:'benchmark_capital_exhausted'}
  }
  const endValue=safe(Math.max(0,units)*last),gain=endValue==null?null:safe(endValue-opening-net),ret=gain==null?null:safe(gain/capital*100)
  if(endValue==null||ret==null||ret < -100)return {...row,reason:'invalid_numeric_range'}
  const difference=safe(p.returnPercent-ret),excess=safe(closing-endValue)
  if(difference==null||excess==null)return {...row,reason:'invalid_numeric_range'}
  facts.forEach(o=>used.set(o.id,o))
  return {...row,status:'comparable',reason:null,benchmarkEndValueUsd:endValue,benchmarkReturnPercent:ret,differencePercentagePoints:difference,excessChangeUsd:excess,observationIds:[...new Set(facts.map(o=>o.id))]}
 })
 const complete=periods.length>0&&periods.every((p:Row)=>p.status==='comparable')
 const linked=complete?safe((periods.reduce((n:number,p:Row)=>n*(1+p.benchmarkReturnPercent/100),1)-1)*100):null
 const book=complete?safe((periods.reduce((n:number,p:Row)=>n*(1+p.portfolioReturnPercent/100),1)-1)*100):null
 return {method:CASHFLOW_BENCHMARK_METHOD,note:CASHFLOW_BENCHMARK_NOTE,index,label:`CMC ${index}`,subject,status:complete&&linked!=null&&book!=null?'comparable':'incomplete',periods,
  benchmarkReturnPercent:linked,portfolioReturnPercent:book,differencePercentagePoints:linked!=null&&book!=null?safe(book-linked):null,observations:[...used.values()]}
}

/** Two bounded shared-database reads, never a CMC call per portfolio or viewer.
 * The caller must have authorized the private book before reaching this reader. */
export async function withCashflowBenchmarks(db:any,performance:Row,now=Date.now()):Promise<Row>{
 const base={...performance,bookVersion:performance.version,benchmarkComparisons:[] as Row[]}
 const indexes=['100','20'] as const
 const unavailable=(status:string,reason:string)=>({...base,benchmarkComparisons:indexes.map(index=>({method:CASHFLOW_BENCHMARK_METHOD,index,label:`CMC ${index}`,status,reason,periods:[],observations:[]}))})
 if(performance.status==='error')return unavailable('error','portfolio_history_read_failed')
 if(!performance.periods?.length)return unavailable('incomplete','two_dated_snapshots_required')
 try{
  const settings=await loadCmcOperatingSettings(db,now),policy=cmcPolicyEnvironment(settings,key=>{try{return Deno.env.get(key)}catch{return undefined}},now)
  if(policy('CMC_ALLOW_HISTORICAL_RETENTION')!=='true'||policy('CMC_ALLOW_AI_PROCESSING')!=='true')return unavailable('restricted','current_source_permission_required')
  if(!performance.periods.some((p:Row)=>p.status==='estimate')){
   const comparisons=indexes.map(index=>cashflowBenchmark(performance,[],index,now))
   return {...base,benchmarkComparisons:comparisons,version:await digest(stableJson({method:CASHFLOW_BENCHMARK_METHOD,bookVersion:performance.version,comparisons}))}
  }
  const from=instant(performance.periods[0].from),to=instant(performance.periods.at(-1).to)
  if(from==null||to==null||to<from||to>now||to-from>90*86400000)return unavailable('incomplete','unsupported_time_window')
  const reads=await Promise.all(indexes.map(index=>db.from('intel_market_observations').select('observation').eq('provider','coinmarketcap').eq('subject',`index:coinmarketcap:${index}`).eq('metric','index_level').gte('observed_at',new Date(from).toISOString()).lte('observed_at',new Date(to).toISOString()).gt('retain_until',new Date(now).toISOString()).order('observed_at',{ascending:true}).order('id',{ascending:true}).limit(501)))
  const comparisons=reads.map((r,index)=>r.error||!Array.isArray(r.data)?{method:CASHFLOW_BENCHMARK_METHOD,index:indexes[index],label:`CMC ${indexes[index]}`,status:'error',reason:'index_history_read_failed',periods:[],observations:[]}:r.data.length>500?{method:CASHFLOW_BENCHMARK_METHOD,index:indexes[index],label:`CMC ${indexes[index]}`,status:'incomplete',reason:'source_limit_exceeded',periods:[],observations:[]}:cashflowBenchmark(performance,r.data.map((r:Row)=>r.observation),indexes[index],now))
  return {...base,benchmarkComparisons:comparisons,version:await digest(stableJson({method:CASHFLOW_BENCHMARK_METHOD,bookVersion:performance.version,comparisons}))}
 }catch{return unavailable('error','index_history_read_failed')}
}
