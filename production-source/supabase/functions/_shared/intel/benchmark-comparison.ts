import {finite,instant,type Observation} from './investigation-evidence.ts'
export const BENCHMARKS={'100':{subject:'index:coinmarketcap:100',capability:'cmc100History',label:'CMC 100'},'20':{subject:'index:coinmarketcap:20',capability:'cmc20History',label:'CMC 20'}} as const
export function benchmarkRequestPlan(from:number,to:number){
 if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<from||to-from>90*86400000)throw Error('invalid_benchmark_window')
 const end=Math.floor(to/86400000)*86400000
 return {interval:'daily',time_end:new Date(end).toISOString(),count:Math.min(10,Math.max(2,Math.floor((end-from)/86400000)+1))}
}
/** Same source, metric, currency and actual instant. Conflicting values at one
 * instant are excluded. No interpolation, rounding dates, or looking ahead. */
function facts(observations:Observation[],subject:string,metric:string,unit:string,at:number){
 const times=new Map<number,Observation|null>()
 for(const o of observations){const t=instant(o.observedAt),known=instant(o.recordedAt),v=finite(o.value)
  if(o.subject!==subject||o.provider!=='coinmarketcap'||o.metric!==metric||o.unit!==unit||t==null||known==null||t>at||known>at||v==null||v<0)continue
  const previous=times.get(t)
  if(times.has(t)&&(!previous||finite(previous.value)!==v)){times.set(t,null);continue}
  if(!previous||known>instant(previous.recordedAt)!)times.set(t,o)
 }
 return times
}
export function alignedBenchmark(observations:Observation[],subject:string,index:'100'|'20',at:number){
 const spec=BENCHMARKS[index],benchmark=facts(observations,spec.subject,'index_level','index_points',at),asset=facts(observations,subject,'price','USD',at)
 const rows=[...benchmark].sort(([a],[b])=>a-b).slice(-10).map(([t,b])=>({t,asset:asset.get(t)||null,benchmark:b,assetReturn:null as number|null,benchmarkReturn:null as number|null,difference:null as number|null}))
 const paired=rows.filter(r=>r.asset&&r.benchmark),baseline=paired[0],validBaseline=baseline&&Number(baseline.asset!.value)>0&&Number(baseline.benchmark!.value)>0
 if(validBaseline)for(const row of rows){if(row.asset&&row.benchmark){const assetReturn=(Number(row.asset.value)/Number(baseline.asset!.value)-1)*100,benchmarkReturn=(Number(row.benchmark.value)/Number(baseline.benchmark!.value)-1)*100;if(Number.isFinite(assetReturn)&&Number.isFinite(benchmarkReturn)&&Number.isFinite(assetReturn-benchmarkReturn)){row.assetReturn=assetReturn;row.benchmarkReturn=benchmarkReturn;row.difference=assetReturn-benchmarkReturn}}}
 return {method:'exact-benchmark-1',subject,index:index,label:spec.label,status:paired.length<2?'insufficient_matching_times':!validBaseline?'zero_baseline':'comparable',rows,baselineAt:baseline?.t??null,pairedCount:paired.length,missingCount:rows.length-paired.length,
  note:'Only identical reported timestamps are compared. USD asset price and index points are separately normalized at the first shared observation. Missing or contradictory observations remain gaps; no annualization, interpolation or execution price is implied.'}
}
