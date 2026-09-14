import {chartCapturePolicy,chartPricesReadable,chartRetentionDeadline} from './chart-capture-proof.ts'
import {replayBars} from './chart-replay-projection.ts'
type Env=(key:string)=>string|undefined
export const snapshotSeries=(state:any):any[]=>state.layout?.comparison?state.comparisonSeries||[]:[state]
export function snapshotExportAllowed(state:any,env:Env,now=Date.now()){
 const series=snapshotSeries(state)
 return series.length>0&&series.every(s=>!!s.bars?.length&&chartPricesReadable(s,env,now)&&s.policy?.export===true&&chartCapturePolicy(s.source?.provider,env).export)
}
/** Project each source independently; omitted/expired prices never reload from a provider. */
export function projectSnapshotPrices(state:any,env:Env,now=Date.now()){
 const original=snapshotSeries(state),series=original.map(s=>{
  const readable=!!s.bars?.length&&chartPricesReadable(s,env,now)
  return {...s,bars:readable?replayBars(s.bars,state.layout?.replay):null,availability:{prices:readable,retainUntil:readable?chartRetentionDeadline(s,env):null}}
 })
 const available=series.filter(s=>s.availability.prices),restricted=original.some((s,i)=>s.bars?.length&&!series[i].bars)
 const projected=state.layout?.comparison?{...state,comparisonSeries:series}:{...state,bars:series[0]?.bars??null}
 return {state:projected,availability:{prices:available.length>0,availableSources:available.length,totalSources:series.length,
  retainUntil:available.length?Math.min(...available.map(s=>s.availability.retainUntil)):null,export:snapshotExportAllowed(state,env,now),
  exportReason:snapshotExportAllowed(state,env,now)?null:'Image export is unavailable for this saved capture under its source policy. You can still reopen your saved research and manage chart links.'},
  ...(restricted?{viewRestrictions:['Some saved prices have expired or are unavailable under the current source policy. Your notes and original source fingerprints remain available.']}:{} )}
}
