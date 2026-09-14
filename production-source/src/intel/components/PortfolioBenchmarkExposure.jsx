import React,{useState} from 'react'
import {Link} from 'react-router'
import {InvestigationTable,time,value} from './InvestigationTable'
export default function PortfolioBenchmarkExposure({exposures,portfolioId}){
 const [index,setIndex]=useState('100'),e=exposures?.find(r=>r.index===index)
 if(!e)return null
 return <details className="my-3"><summary>Current exposure to recorded market moves</summary><p>{e.note}</p>
  <label>Comparison index <select className="select" value={index} onChange={ev=>setIndex(ev.target.value)}><option value="100">CMC 100</option><option value="20">CMC 20</option></select></label>
  {e.status==='insufficient_matching_times'?<p>There is not enough matching source history across the included positions. Refresh the asset's benchmark investigation, then create a new portfolio reading.</p>:<p>{time(e.from)} – {time(e.to)} · Covered current value {value(e.coveredValueUsd)} USD ({e.coveredPortfolioPercent==null?'portfolio share unavailable':`${value(e.coveredPortfolioPercent)}% of the recorded book`}). Applying those recorded asset moves to the included current values gives {value(e.hypotheticalMoveUsd)} USD, before flows, fees or trading.</p>}
  <InvestigationTable rows={e.rows||[]} caption="Current-weight scenario contributions, not realized portfolio returns" columns={[
   ['Position',r=><Link className="intel-text-link" to={`/intel/investigate?asset=${encodeURIComponent(r.canonicalAssetKey)}&lens=benchmark&benchmark=${index}${portfolioId?`&portfolio=${portfolioId}`:''}`}>{r.name||r.canonicalAssetKey}</Link>],
   ['Current value (USD)',r=>value(r.positionValueUsd)],['Asset price move',r=>`${value(r.movePercent)}%`],[e.label,r=>`${value(r.indexMovePercent)}%`],['Scenario contribution (USD)',r=>value(r.hypotheticalMoveUsd)],
   ['Original evidence',r=><details><summary>{r.positionPriceStatus||'Price status unavailable'}</summary><p>Position price observed {time(r.positionObservedAt)}</p>{r.observations?.map(o=><p key={o.id} className="break-all">{o.value} {o.unit} · observed {time(o.observedAt)}, recorded {time(o.recordedAt)} · {o.id}</p>)}</details>],
  ]}/>
  {!!e.excluded?.length&&<details><summary>{e.excluded.length} excluded positions</summary>{e.excluded.map(r=><p key={r.canonicalAssetKey} className="break-all">{r.canonicalAssetKey}: {r.reason.replaceAll('_',' ')}</p>)}</details>}
 </details>
}
