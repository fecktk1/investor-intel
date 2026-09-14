import {researchIdentity} from './research-identity.ts'
import {canonicalAssetKey} from '../investor-portfolio/canonical.ts'
import {instant,type Observation} from './investigation-evidence.ts'
import {projectDexEvidence} from './cmc-contract-projection.ts'
import {loadCmcOperatingSettings,cmcPolicyEnvironment} from '../market-assets/cmc-operating-settings.ts'

export const CMC_CONTRACT_METRICS=['price','holder_count','liquidity_event_usd','swap_event_usd'] as const
export function contractEvidenceSubject(key:string):string|null {
 const i=researchIdentity({canonicalKey:key})
 return i.chain&&i.tokenAddress?canonicalAssetKey(i.chain,i.tokenAddress):null
}
/** No provider requests, private records or symbol-based joins. Each metric has
 * its own bound so a busy liquidity tape cannot crowd out holder/price facts. */
export async function readCmcContractEvidence(db:any,key:string,now:number,purpose:'research'|'display'='research'){
 const subject=contractEvidenceSubject(key),base={subject,evaluated_at:new Date(now).toISOString(),observations:[] as Observation[],has_more:false,
  coverage:'Exact-contract CMC observations. Holder accounts are not people; pool liquidity events are not personal trades or executable depth. Undated security/count snapshots are not dated observations.'}
 if(!subject)return {...base,status:'unsupported',reason:'A verified token contract is required.',sources:[]}
 const policy=cmcPolicyEnvironment(await loadCmcOperatingSettings(db,now),key=>{try{return Deno.env.get(key)}catch{return undefined}},now)
 if(policy('CMC_ALLOW_HISTORICAL_RETENTION')!=='true'||purpose==='research'&&policy('CMC_ALLOW_AI_PROCESSING')!=='true')return {...base,status:'restricted',reason:'Current source permission does not allow this retained evidence use.',sources:[]}
 const results=await Promise.all(CMC_CONTRACT_METRICS.map(async metric=>{
  const maximum=metric==='price'?1:metric==='holder_count'?31:50,limit=maximum*2+1
  try{
   const {data,error}=await db.from('intel_market_observations').select('observation').eq('subject',subject).eq('provider','coinmarketcap').eq('metric',metric)
    .gte('observed_at',new Date(now-31*86400000).toISOString()).lte('observed_at',new Date(now).toISOString()).gt('retain_until',new Date(now).toISOString())
    .order('observed_at',{ascending:false}).order('id',{ascending:false}).limit(limit)
   if(error||!Array.isArray(data))throw Error('contract_read_failed')
   const permitted=data.map((r:any)=>r.observation as Observation).filter((o:Observation)=>o?.subject===subject&&o.provider==='coinmarketcap'&&o.metric===metric&&
    (purpose==='display'||o.aiAllowed===true)&&instant(o.observedAt)!=null&&instant(o.observedAt)!<=now&&instant(o.recordedAt)!=null&&instant(o.recordedAt)!<=now)
   const projected=projectDexEvidence(permitted,now),observations=projected.slice(0,maximum)
   return {metric,status:observations.length?'available':'missing',observations,has_more:data.length>=limit||projected.length>maximum,reason:observations.length?null:'No permitted retained observations in this window.'}
  }catch{return {metric,status:'error',observations:[] as Observation[],has_more:false,reason:'Retained contract evidence could not be read.'}}
 }))
 const observations=results.flatMap(r=>r.observations),errors=results.filter(r=>r.status==='error')
 return {...base,observations,has_more:results.some(r=>r.has_more),sources:results.map(({observations:_,...r})=>r),status:errors.length?observations.length?'partial':'error':observations.length?'available':'missing',
  reason:errors.length?'Some retained contract sources could not be read. Available records keep their original dates.':observations.length?null:'No permitted retained CMC contract evidence.'}
}
