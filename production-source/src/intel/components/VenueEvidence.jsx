import React,{useMemo,useState} from 'react'
import {venueContext} from '../../../supabase/functions/_shared/intel/venue-context'
import {InvestigationTable,time,value} from './InvestigationTable'
import ExchangeDisclosures from './ExchangeDisclosures'
export default function VenueEvidence({observations=[],subject,at,depth=null,onSelect}){
 const [venue,setVenue]=useState(''),result=useMemo(()=>venueContext(observations,subject,at,venue||null),[observations,subject,at,venue]),[depthKey,setDepthKey]=useState(''),[record,setRecord]=useState(null)
 const inspect=o=>onSelect?onSelect(o):setRecord(o)
 const quotes=depth?.quotes||[],selectedDepth=quotes.find(d=>d.sourceRef+':'+d.side===depthKey)||quotes[0]
 return <div className="intel-venue-evidence"><label className="intel-inline-field">Derivative venue<select value={venue} onChange={e=>setVenue(e.target.value)}><option value="">All covered venues</option>{result.choices.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
  <p className="intel-analysis-caption">{result.coverage}</p><p>{result.contracts.length} compatible contracts · covered open interest {result.totalOpenInterestUsd==null?'unavailable':`$${value(result.totalOpenInterestUsd)}`}. Evaluated {time(at)}.</p>
  <ExchangeDisclosures venues={result.choices} subject={subject}/>
  {!!result.venues.length&&<InvestigationTable caption="Covered derivatives by venue" rows={result.venues} columns={[
   ['Venue',v=>v.name],['Open interest (USD)',v=>value(v.openInterestUsd)],['Share of covered asset OI',v=>v.sharePercent==null?'No denominator':`${value(v.sharePercent)}%`],['Contracts',v=>v.contracts.length],
  ]}/>}
  {!result.venues.length&&<p>No fresh, compatible open-interest population is available at this evaluation time. Retained observations remain available below.</p>}
  <details><summary>Contract funding and observation clocks</summary><InvestigationTable caption="Contract-level funding; intervals remain explicit" rows={result.contracts} columns={[
   ['Contract',c=><button className="intel-text-link" onClick={()=>inspect(c.observation)}>{c.venue} · {c.id}</button>],['OI (USD)',c=>value(c.openInterestUsd)],['Reported funding',c=>c.fundingRatePercent==null?'Unavailable':`${Number(c.fundingRatePercent).toLocaleString(undefined,{maximumSignificantDigits:10})} ${c.fundingUnit==='unknown'?'(unit unconfirmed)':c.fundingUnit==='ratio'?'fraction':'%'}`],['Interval',c=>c.fundingPeriodSeconds?`${c.fundingPeriodSeconds/3600} hours`:'Unconfirmed'],['Observed',c=>time(c.observedAt)],['Known',c=>time(c.observation?.recordedAt)],
  ]}/>{result.funding.length>0&&<InvestigationTable caption="OI-weighted funding within each confirmed interval" rows={result.funding} columns={[
   ['Interval',g=>`${g.periodSeconds/3600} hours`],['Weighted rate',g=>g.ratePercent==null?'No positive weight':`${value(g.ratePercent)}%`],['Covered contracts',g=>g.contracts],['Weight (USD OI)',g=>value(g.openInterestUsd)],
  ]}/>}<p className="intel-analysis-caption">{result.fundingUnknown} contracts excluded from funding averages because unit, interval, weight or response membership is unconfirmed. Rates are not annualized.</p></details>
  <div><h4>Liquidation context</h4>{result.liquidationReason?<p>{result.liquidationReason}</p>:<InvestigationTable rows={result.liquidations} columns={[
   ['Rolling window',o=>`${o.periodSeconds/3600} hours`],['Covered liquidations (USD)',o=>value(o.value)],['Observed',o=>time(o.observedAt)],['Known',o=>time(o.recordedAt)],['Source',o=><button className="intel-text-link" onClick={()=>inspect(o)}>{o.provider}</button>],
  ]}/>}<p className="intel-analysis-caption">Rolling windows overlap; their totals must not be added. An asset total and an exchange total do not establish the asset’s liquidation activity on that exchange.</p></div>
  {depth&&<details><summary>Recorded venue depth</summary>{depth.status==='error'&&<p role="alert">{depth.reason}</p>}{quotes.length>0?<><label>Spot venue and side<select value={selectedDepth.sourceRef+':'+selectedDepth.side} onChange={e=>setDepthKey(e.target.value)}>{quotes.map(d=><option key={d.sourceRef+':'+d.side} value={d.sourceRef+':'+d.side}>{d.venue} · {d.pair} · {d.side}</option>)}</select></label><InvestigationTable rows={selectedDepth.levels} columns={[
   ['Recorded price (USD)',l=>value(l.price)],['Available quantity',l=>value(l.quantity)],['Observed',()=>time(selectedDepth.observedAt)],
  ]}/><p>{selectedDepth.coverage}</p></>:<p>{depth.reason}</p>}<p className="intel-analysis-caption">Spot-book venue selection is separate from the derivative contract population. No order or execution is created.</p></details>}
 {record&&<aside className="intel-source-record" aria-label="Recorded venue observation"><button className="intel-text-link" onClick={()=>setRecord(null)}>Close observation</button><p>{record.metric}: {value(record.value)} {record.unit}</p><p>Observed {time(record.observedAt)} · known {time(record.recordedAt)}</p><p className="break-all">{record.sourceRef}</p></aside>}
 </div>
}
