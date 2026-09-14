import React,{useMemo,useState} from 'react'
import {fragilityHistory} from '../../../supabase/functions/_shared/intel/fragility-history.ts'
import {InvestigationTable,time,value} from './InvestigationTable'

export default function FragilityHistory({observations,subject,from,at,onTime,onSelect}) {
 const result=useMemo(()=>fragilityHistory(observations,subject,from??at-30*86400000,at),[observations,subject,from,at]),[selected,setSelected]=useState(null)
 const rows=result.rows,selection=rows.find(r=>r.id===selected),start=from??at-30*86400000,x=t=>60+(t-start)/(at-start||1)*560,y=v=>175-v*1.4
 return <section className="intel-fragility-history"><h3>Recorded venue concentration</h3><p className="intel-analysis-caption">{result.coverage}</p>
  {rows.length>0?<><svg className="intel-liquidation-plot" viewBox="0 0 660 225" role="img" aria-label="Largest venue share of covered open interest over time. The table provides exact values and source selection.">
   {[0,50,100].map(n=><g key={n}><line x1="60" x2="620" y1={y(n)} y2={y(n)} strokeDasharray={n?'2 4':undefined}/><text x="52" y={y(n)+4} textAnchor="end">{n}%</text></g>)}
   <text x="60" y="18">Largest covered venue share</text>{rows.filter(r=>r.largestVenueShare!=null).map(r=><circle key={r.id} cx={x(r.observedAt)} cy={y(r.largestVenueShare)} r={r.id===selected?6:4}><title>{time(r.observedAt)} · {value(r.largestVenueShare)}%</title></circle>)}
   <text x="60" y="211">{time(start)}</text><text x="620" y="211" textAnchor="end">{time(at)}</text>
  </svg><InvestigationTable rows={[...rows].reverse()} pageSize={6} columns={[
   ['Observed',r=><button className="intel-text-link" onClick={()=>setSelected(r.id)}>{time(r.observedAt)}</button>],['Largest venue',r=>r.result.venues[0]?.name||'—'],['Share',r=>r.largestVenueShare==null?'Unavailable':`${value(r.largestVenueShare)}%`],['Change',r=>r.largestVenueShareChange==null?'Not comparable':`${value(r.largestVenueShareChange)} pp`],['Covered OI (USD)',r=>value(r.totalOpenInterestUsd)],['Contracts',r=>`${r.result.coveredContracts} included / ${r.expectedContracts??'?'} expected`],
  ]}/>{selection&&<div className="intel-structure-detail" aria-label="Selected concentration snapshot"><p>{selection.comparisonReason}</p><p className="intel-analysis-caption">Recorded by {time(selection.knownAt)} · HHI {value(selection.concentrationHhi)} · Covered OI change {selection.openInterestChangePercent==null?'not comparable':`${value(selection.openInterestChangePercent)}%`}. {selection.hasMore===true?'The source reported more contracts beyond this page.':'Source coverage is the returned contract set.'}</p><div className="flex flex-wrap gap-4"><button className="btn" onClick={()=>onTime?.(selection.knownAt)}>Move research cursor here</button><button className="intel-text-link" onClick={()=>onSelect?.(selection.observations[0])}>Inspect source observation</button></div></div>}</>:<p>No retained response batches are available in this time window.</p>}
  {result.legacyObservations>0&&<p className="intel-analysis-caption">{result.legacyObservations} older observations lack recorded response membership.</p>}{result.omittedSnapshots>0&&<p className="intel-analysis-caption">Showing the latest 120 of {result.totalSnapshots} loaded snapshots. Narrow the period to inspect earlier points.</p>}
  {result.inputTruncated&&<p role="status">This view is limited to 10,000 loaded observations. Narrow the period for complete batch membership.</p>}
 </section>
}
