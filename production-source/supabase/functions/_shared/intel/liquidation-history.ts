import {instant,finite,observationState,type Observation} from './investigation-evidence.ts'
const WINDOWS:Record<string,number>={'1h':3600,'4h':14400,'24h':86400}
/** Rolling windows overlap. Keep individual samples; summing them would double count liquidations. */
export function liquidationHistory(observations:Observation[],subject:string,window:string,from:number,at:number){
 if(!WINDOWS[window]||!Number.isFinite(from)||!Number.isFinite(at)||from>at)throw new Error('invalid_liquidation_window')
 const latest=new Map<string,Observation>()
 for(const o of observations){const t=instant(o.observedAt),recorded=instant(o.recordedAt),v=finite(o.value)
  if(o.subject!==subject||o.metric!==`liquidations_${window}`||o.unit!=='USD'||o.periodSeconds!==WINDOWS[window]||t==null||recorded==null||t<from||t>at||recorded>at||v==null||v<0||o.state&&o.state!=='known')continue
  const key=[o.provider,o.universe,t].join('|'),old=latest.get(key)
  if(!old||recorded>instant(old.recordedAt)!)latest.set(key,o)
 }
 const rows=[...latest.values()].sort((a,b)=>instant(a.observedAt)!-instant(b.observedAt)!),current=rows.at(-1)??null
 return {rows,current,currentState:observationState(current??undefined,at,3600),windowSeconds:WINDOWS[window],coverage:'Reported USD liquidations over the preceding window, across provider-covered venues. Windows overlap; samples are not added together. Gaps have no implied zero value.'}
}
