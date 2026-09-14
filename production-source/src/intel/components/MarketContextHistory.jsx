import React from 'react'
import {InvestigationTable,time,value} from './InvestigationTable'
export function MarketContextHistory({rows,capability}){
 const global=capability==='globalHistory',label=global?'Total market cap (USD)':capability==='cmc100History'?'CMC 100 index value':'CMC 20 index value'
 const data=rows.map(r=>({time:r.timestamp||r.update_time,number:global?r.quote?.total_market_cap:r.value,...r})).filter(r=>Number.isFinite(Date.parse(r.time))).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))
 const points=data.filter(r=>typeof r.number==='number'&&Number.isFinite(r.number)),xs=points.map(r=>Date.parse(r.time)),ys=points.map(r=>r.number),x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys)
 return <section className="intel-open-section"><h2>{label}</h2><p className="intel-analysis-caption">Daily observations at their reported times. Missing intervals remain gaps. Index values are benchmark levels, not token prices.</p>
  {data.length>0&&<p className="intel-analysis-caption">{data.length} observations · {time(data[0].time)} to {time(data.at(-1).time)}{points.length>0?` · Observed values ${value(y0)} to ${value(y1)}`:''}</p>}
  {points.length>1&&x1>x0&&<svg viewBox="0 0 720 140" role="img" aria-label={`${label}; exact values in the table below`} style={{width:'100%',maxHeight:180}}><path fill="none" stroke="var(--accent)" strokeWidth="2" d={points.map((r,i)=>`${i===0||Date.parse(r.time)-Date.parse(points[i-1].time)>129600000?'M':'L'}${12+(Date.parse(r.time)-x0)/(x1-x0)*696},${128-(y1===y0?0.5:(r.number-y0)/(y1-y0))*116}`).join(' ')}/>{points.map(r=><circle key={r.time} cx={12+(Date.parse(r.time)-x0)/(x1-x0)*696} cy={128-(y1===y0?0.5:(r.number-y0)/(y1-y0))*116} r="2" fill="var(--accent)"/>)}</svg>}
  {points.length>1&&<p className="intel-analysis-caption flex justify-between gap-4"><span>{new Date(x0).toISOString().slice(0,10)} UTC</span><span>{new Date(x1).toISOString().slice(0,10)} UTC</span></p>}
  <InvestigationTable caption={`${label} — reported history`} rows={data} columns={[[ 'Observed',r=>time(r.time)],[label,r=>value(r.number)],...(global?[[ 'BTC dominance (%)',r=>value(r.btc_dominance)],['ETH dominance (%)',r=>value(r.eth_dominance)]]:[['Reported constituents',r=>Array.isArray(r.constituents)?r.constituents.length:'Unreported']])]}/>
 </section>
}
