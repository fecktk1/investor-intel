import {finite,instant,type Observation} from './investigation-evidence.ts'
import {projectDexEvidence} from './cmc-contract-projection.ts'

const DAY=86400000,ALIGNMENT=3600000
const known=(o:Observation,at:number)=>instant(o.observedAt)!=null&&instant(o.observedAt)!<=at&&instant(o.recordedAt)!=null&&instant(o.recordedAt)!<=at
const valid=(o:Observation,metric:string,unit:string)=>o.provider==='coinmarketcap'&&o.metric===metric&&o.unit===unit&&finite(o.value)!=null&&finite(o.value)!>=0
export function adoptionHolderWindow(observations:Observation[],subject:string,at:number){
 const rows=projectDexEvidence(observations,at).filter(o=>o.subject===subject&&valid(o,'holder_count','accounts')&&o.periodSeconds===86400&&typeof o.metadata?.population==='string'&&o.metadata.population.length>0&&known(o,at)).sort((a,b)=>instant(b.observedAt)!-instant(a.observedAt)!)
 const current=rows[0]??null,target=current?instant(current.observedAt)!-7*DAY:null
 const previous=current?rows.find(o=>Math.abs(instant(o.observedAt)!-target!)<=1000&&o.metadata?.population===current.metadata?.population)??null:null
 return {current,previous}
}
/** Same contract population and source ranking universe, aligned to two actual
 * daily holder clocks. Missing ranks do not mean rank zero or lost holders. */
export function adoptionAttention(observations:Observation[],contract:string,market:string|null,at:number){
 const holders=adoptionHolderWindow(observations,contract,at),{current,previous}=holders
 const base={method:'participation-attention-1',contract,market,periodDays:7,maxAlignmentSeconds:3600,evaluatedAt:new Date(at).toISOString(),
  coverage:'Holder accounts are not people. Ranking is attention in the source snapshot, not a narrative score. Changes describe association, not causation.',
  currentAt:current?.observedAt??null,previousAt:previous?.observedAt??null,holderChange:current&&previous?finite(current.value)!-finite(previous.value)!:null,
  holderChangePercent:current&&previous&&finite(previous.value)!>0?(finite(current.value)!/finite(previous.value)!-1)*100:null,
  rankImprovement:null as number|null,volumeChangePercent:null as number|null,observations:[current,previous].filter(Boolean) as Observation[]}
 if(!current||!previous||!market)return {...base,status:'baseline_needed',reason:!market?'A verified contract-to-market identity is required.':'Two daily holder observations from the same population, seven days apart, are required.'}
 const rows=observations.filter(o=>o.subject===market&&o.provider==='coinmarketcap'&&known(o,at))
 const near=(metric:string,unit:string,target:string,universe?:string|null)=>rows.filter(o=>valid(o,metric,unit)&&(universe===undefined||o.universe===universe)&&
  Math.abs(instant(o.observedAt)!-instant(target)!)<=ALIGNMENT&&(metric!=='volume_24h'||o.periodSeconds===86400))
  .sort((a,b)=>Math.abs(instant(a.observedAt)!-instant(target)!)-Math.abs(instant(b.observedAt)!-instant(target)!)||instant(b.recordedAt)!-instant(a.recordedAt)!)[0]??null
 const rank=near('attention_rank','rank',current.observedAt!),oldRank=rank&&near('attention_rank','rank',previous.observedAt!,rank.universe)
 const volume=near('volume_24h','USD',current.observedAt!),oldVolume=volume&&near('volume_24h','USD',previous.observedAt!,volume.universe)
 const rankImprovement=rank&&oldRank&&typeof rank.universe==='string'&&rank.universe.length>0&&rank.universe===oldRank.universe&&finite(rank.value)!>0&&finite(oldRank.value)!>0?finite(oldRank.value)!-finite(rank.value)!:null
 const volumeChangePercent=volume&&oldVolume&&finite(oldVolume.value)!>0?(finite(volume.value)!/finite(oldVolume.value)!-1)*100:null
 return {...base,rankImprovement,volumeChangePercent,observations:[...base.observations,...[rank,oldRank,volume,oldVolume].filter(Boolean) as Observation[]],
  status:rankImprovement!=null&&volumeChangePercent!=null?'comparable':'partial',
  reason:rankImprovement==null?'Comparable attention snapshots within one hour of both holder dates are unavailable.':volumeChangePercent==null?'Comparable 24-hour volume observations or a positive baseline are unavailable.':'Both changes use the same seven-day holder window, with at most one hour of source-clock difference at each end.'}
}

/** One bounded retained read across two time windows; no provider calls. */
export async function readAdoptionAttention(db:any,holderRows:Observation[],contract:string,market:string|null,at:number,purpose:'research'|'display'='research'){
 const window=adoptionHolderWindow(holderRows,contract,at),fallback=adoptionAttention(holderRows,contract,market,at)
 if(!window.current||!window.previous||!market)return fallback
 if(!/^market:coinmarketcap:[1-9][0-9]*$/.test(market))return {...fallback,status:'unsupported',reason:'No verified CMC market identity.'}
 const windows=[window.current,window.previous].map(o=>{const center=instant(o.observedAt)!;return `and(observed_at.gte.${new Date(center-ALIGNMENT).toISOString()},observed_at.lte.${new Date(Math.min(at,center+ALIGNMENT)).toISOString()})`})
 try{
  const {data,error}=await db.from('intel_market_observations').select('observation').eq('subject',market).eq('provider','coinmarketcap')
   .in('metric',['attention_rank','volume_24h']).or(windows.join(',')).gt('retain_until',new Date(at).toISOString()).order('observed_at',{ascending:false}).order('id',{ascending:false}).limit(129)
  if(error||!Array.isArray(data))throw Error('retained_attention_unavailable')
  const permitted=data.slice(0,128).map((r:any)=>r.observation as Observation).filter((o:Observation)=>o&&(purpose==='display'||o.aiAllowed===true))
  const result=adoptionAttention([...holderRows,...permitted],contract,market,at)
  return {...result,has_more:data.length>128,...(data.length>128?{status:'partial',reason:'The bounded source read is incomplete. Available original observations remain visible; a complete comparison is withheld.',rankImprovement:null,volumeChangePercent:null}:{})}
 }catch{return {...fallback,status:'error',reason:'Retained attention evidence could not be read. This is not an empty ranking list.'}}
}
