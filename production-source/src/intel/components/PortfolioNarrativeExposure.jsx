import React,{useState} from 'react'
import {Link} from 'react-router'

const money=n=>n==null?'Unavailable':Number(n).toLocaleString(undefined,{style:'currency',currency:'USD',maximumFractionDigits:2})
const percent=n=>n==null?'Unavailable':`${Number(n).toLocaleString(undefined,{maximumFractionDigits:2})}%`
const time=v=>v&&Number.isFinite(Date.parse(v))?new Date(v).toLocaleString(undefined,{timeZoneName:'short'}):'Not recorded'

export default function PortfolioNarrativeExposure({exposure:e,portfolioId}) {
 const [view,setView]=useState('sectors'),[page,setPage]=useState(0)
 if(!e)return null
 const groups=e[view]||[],last=Math.max(0,Math.ceil(groups.length/5)-1),current=Math.min(page,last),visible=groups.slice(current*5,current*5+5)
 return <details className="my-3"><summary>Sectors and narratives in this portfolio</summary>
  <p>Positions can belong to several narratives. Group percentages overlap.</p>
  <details><summary>How exposure is calculated</summary><p>{e.method}</p></details>
  {e.status==='error'?<p role="alert">Portfolio membership evidence could not be read. Create a new portfolio reading to retry. This is a failed read, not zero exposure.</p>:<>
   <p>{e.positionsClassified} of {e.positionsRequested} research positions have eligible membership records. Their value counted once is {money(e.uniquePricedSubtotalUsd)}{e.unpriced?` plus ${e.unpriced} unpriced positions`:''}. Other holdings remain unclassified.</p>
   <label>Group positions by <select className="select" value={view} onChange={event=>{setView(event.target.value);setPage(0)}}><option value="sectors">Investor Intel categories</option><option value="narratives">Narratives</option></select></label>
   {groups.length?<div className="intel-table-scroll"><table aria-label="Portfolio sectors and narratives"><thead><tr><th scope="col">Group</th><th scope="col">Position value</th><th scope="col">Portfolio share</th><th scope="col">Holdings and evidence</th></tr></thead><tbody>{visible.map(g=><tr key={g.id}>
    <th scope="row">{g.slug?<Link to={`/intel/narratives/${encodeURIComponent(g.slug)}`}>{g.name}</Link>:g.name}</th>
    <td>{money(g.valueUsd)}{g.unpriced>0&&<small>Priced subtotal {money(g.pricedSubtotalUsd)} · {g.unpriced} unpriced</small>}</td><td>{percent(g.portfolioAllocationPct)}</td>
    <td><details><summary>{g.positions.length} positions{g.stalePositions?` · ${g.stalePositions} without a current verified price`:''}</summary>{g.positions.map(key=>{
     const position=e.positions.find(p=>p.canonicalAssetKey===key)
     if(!position)return null
     const memberships=position.memberships.filter(m=>view==='narratives'?m.narrativeId===g.id:m.category===g.id)
     return <div key={key} className="border-t border-[var(--border-default)] py-2"><p><Link className="intel-text-link" to={portfolioId?`/intel/portfolio/${encodeURIComponent(portfolioId)}/asset/${encodeURIComponent(key)}`:`/intel/asset/${encodeURIComponent(key)}`}>{position.name}</Link> · {money(position.valueUsd)} · {position.priceStatus||'Price status unavailable'}</p><p>Position observed {time(position.positionObservedAt)}</p>{memberships.map(m=><p key={m.id}>{m.name} · {m.provider} · {m.source||'Membership source not specified'}<br/>Membership recorded {time(m.membershipRecordedAt)}. Effective time not reported.<br/><small>{m.sourceRef} · {m.taxonomyRef}</small></p>)}</div>
    })}</details></td>
   </tr>)}</tbody></table></div>:<p>No eligible membership records were included. This does not establish that the portfolio has no sector exposure.</p>}
   {groups.length>5&&<nav className="intel-chart-navigation" aria-label="Portfolio membership pages"><button type="button" disabled={!current} onClick={()=>setPage(current-1)}>Previous groups</button><span>Page {current+1} of {last+1}</span><button type="button" disabled={current===last} onClick={()=>setPage(current+1)}>Next groups</button></nav>}
   {!!e.excluded?.length&&<details><summary>{e.excluded.length} unclassified research positions</summary>{e.excluded.map(p=><p key={p.canonicalAssetKey}>{p.canonicalAssetKey}: {p.reason.replaceAll('_',' ')}</p>)}</details>}
  </>}
 </details>
}
