import React from 'react'
import {InvestigationTable,time,value} from './InvestigationTable'
export default function AdoptionAttentionEvidence({comparison:r}){
 if(!r)return null
 return <details className="intel-open-section"><summary>Participation versus attention · 7 days</summary>
  <p role={r.status==='error'?'alert':'status'}>{r.status?.replaceAll('_',' ')} · {r.reason}</p>
  <p className="intel-analysis-caption">{r.coverage}</p>
  {(r.currentAt||r.previousAt)&&<p className="intel-analysis-caption">Holder observations: {time(r.previousAt)} → {time(r.currentAt)}. Ranking and volume must fall within one hour of each endpoint.</p>}
  <InvestigationTable caption="Changes across the same holder window" rows={[
   {name:'Holder accounts',value:r.holderChange,unit:'accounts'},{name:'Holder count change',value:r.holderChangePercent,unit:'%'},
   {name:'Attention rank improvement',value:r.rankImprovement,unit:'places'},{name:'Reported 24-hour volume change',value:r.volumeChangePercent,unit:'%'}
  ]} columns={[[ 'Measure',row=>row.name],['Change',row=>row.value==null?'Unavailable':`${value(row.value)} ${row.unit}`]]}/>
  {!!r.observations?.length&&<details><summary>Exact source observations ({r.observations.length})</summary><InvestigationTable rows={r.observations} caption="Original records used by this comparison" columns={[
   ['Measure',o=>o.metric.replaceAll('_',' ')],['Value',o=>`${value(o.value)} ${o.unit}`],['Observed',o=>time(o.observedAt)],['First recorded',o=>time(o.recordedAt)],['Source',o=><details><summary>{o.provider}</summary><p className="break-all">{o.sourceRef}</p><p>Evidence {o.id}</p></details>]
  ]}/></details>}
 </details>
}
