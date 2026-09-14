import {alignedBenchmark} from './benchmark-comparison.ts'
import {instant,type Observation} from './investigation-evidence.ts'
import {cmcPolicyEnvironment,loadCmcOperatingSettings} from '../market-assets/cmc-operating-settings.ts'
const sharedIndexes=new WeakMap<object,{at:number;read:Promise<any[]>}>()
/** Bounded public retained facts only. Portfolio/thesis text is never a query
 * parameter or part of this shared context. */
export async function readAssetBenchmarkEvidence(db:any,subject:string|null,now:number){
 const base={status:'unsupported',reason:'A verified CMC asset identity is required.',comparisons:[] as ReturnType<typeof alignedBenchmark>[],observations:[] as Observation[],has_more:false}
 if(!subject)return base
 try{
  const policy=cmcPolicyEnvironment(await loadCmcOperatingSettings(db,now),key=>{try{return Deno.env.get(key)}catch{return undefined}},now)
  if(policy('CMC_ALLOW_HISTORICAL_RETENTION')!=='true'||policy('CMC_ALLOW_AI_PROCESSING')!=='true')return {...base,status:'restricted',reason:'Current source permission does not allow retained benchmark research.'}
  const subjects=[subject,'index:coinmarketcap:100','index:coinmarketcap:20']
  const readSubject=(s:string)=>{
   let q=db.from('intel_market_observations').select('observation').eq('subject',s).eq('provider','coinmarketcap').eq('metric',s===subject?'price':'index_level').gte('observed_at',new Date(now-11*86400000).toISOString()).lte('observed_at',new Date(now).toISOString()).gt('retain_until',new Date(now).toISOString())
   if(s===subject)q=q.like('observation->>sourceRef','coinmarketcap:/v3/cryptocurrency/quotes/historical:%')
   return q.order('observed_at',{ascending:false}).order('id',{ascending:false}).limit(61)
  }
  let shared=sharedIndexes.get(db)
  if(!shared||shared.at!==now){shared={at:now,read:Promise.all(subjects.slice(1).map(readSubject))};sharedIndexes.set(db,shared)}
  const [assetRead,indexReads]=await Promise.all([readSubject(subject),shared.read]),reads=[assetRead,...indexReads]
  if(reads.some(r=>r.error||!Array.isArray(r.data)))throw Error('benchmark_history_read_failed')
  const observations=reads.flatMap(r=>r.data.slice(0,60).map((r:any)=>r.observation)).filter((o:Observation)=>o?.aiAllowed===true&&subjects.includes(o.subject)&&instant(o.recordedAt)!=null&&instant(o.recordedAt)!<=now),comparisons=(['100','20'] as const).map(i=>alignedBenchmark(observations,subject,i,now))
  return {status:observations.length?'available':'missing',reason:'Retained daily comparisons use exact source timestamps. Open benchmark research for a bounded shared refresh.',comparisons,observations:[...new Map(comparisons.flatMap(c=>c.rows.flatMap(r=>[r.asset,r.benchmark].filter(Boolean))).map(o=>[o!.id,o!])).values()],has_more:reads.some(r=>r.data.length>60)}
 }catch{return {...base,status:'error',reason:'Retained benchmark evidence could not be read.'}}
}
