import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { useSupabase } from '../../lib/useSupabase'
import { useProfile } from '../../lib/profile-context'
import { usePortfolioSelection } from '../lib/PortfolioSelectionContext'
import { useWatchlistSelection } from '../context/WatchlistSelection'
import { calendarGroups, loadBookCalendar } from '../lib/book-calendar'
const stamp=value=>value?new Date(value).toLocaleString(undefined,{timeZoneName:'short'}):'Unavailable'
const safeUrl=value=>{try {const url=new URL(value);return ['https:','http:'].includes(url.protocol)?url.href:null}catch{return null}}
export function CalendarEvidence({event}) {
  const url=safeUrl(event.source_url)
  return <div className="space-y-2"><h3>{event.title}</h3><dl className="intel-source-details"><dt>Schedule</dt><dd>{event.time_precision==='instant'?stamp(event.scheduled_at):`${event.event_date||'Date unavailable'} · time not supplied`}</dd><dt>Status</dt><dd>{event.event_status}</dd><dt>Relevance</dt><dd>{event.relevance}</dd><dt>Source</dt><dd>{url?<a className="intel-text-link" href={url} target="_blank" rel="noreferrer">{event.source||'Original source'}</a>:event.source||'Source unavailable'}</dd><dt>Observed</dt><dd>{stamp(event.observed_at)}</dd><dt>Known here</dt><dd>{stamp(event.recorded_at)}{event.backfilled?' · current record imported; earlier revisions unavailable':''}</dd><dt>Version</dt><dd className="break-all">{event.id}</dd><dt>Source reference</dt><dd className="break-all">{event.source_ref||'Unavailable'}</dd>{Object.entries(event.detail||{}).filter(([,value])=>value!=null).map(([key,value])=><React.Fragment key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></React.Fragment>)}</dl>{event.expires_at&&new Date(event.expires_at).getTime()<Date.now()&&<p role="status">This schedule is stale. Check its source before acting.</p>}</div>
}
export default function BookCalendar({asset=null,portfolioId=null,knownAt:cursor=null,chartLane=false}) {
  const {supabase,user}=useSupabase(),{org}=useProfile(),portfolio=usePortfolioSelection(portfolioId),watchlist=useWatchlistSelection()
  const [days,setDays]=useState(3),[now,setNow]=useState(Date.now),[page,setPage]=useState(0),[inactive,setInactive]=useState(false),[state,setState]=useState({}),[selected,setSelected]=useState(null),[laneWidth,setLaneWidth]=useState(800)
  const pane=useRef(null),opener=useRef(null),lane=useRef(null),knownAt=cursor??now,from=knownAt,to=from+days*24*3600000
  const scope=JSON.stringify([user?.id,org?.id,portfolio.portfolioId,watchlist.selected?.id,asset,from,to,page,inactive])
  useEffect(()=>{setPage(0);setSelected(null)},[user?.id,org?.id,portfolio.portfolioId,watchlist.selected?.id,asset,cursor])
  useEffect(()=>{
    if(!user?.id||!org?.id||portfolio.loading||watchlist.loading||watchlist.error)return
    let alive=true;setState({scope,loading:true})
    loadBookCalendar(supabase,{orgId:org.id,portfolioId:portfolio.portfolioId,watchlistId:watchlist.selected?.id,asset,from,to,knownAt,page,includeInactive:inactive}).then(data=>{if(alive)setState({scope,data})}).catch(error=>{if(alive)setState({scope,error:error.message})})
    return()=>{alive=false}
  },[supabase,scope,portfolio.loading,watchlist.loading,watchlist.error])
  useEffect(()=>{if(selected)pane.current?.showModal()},[selected])
  const close=()=>{pane.current?.close();setSelected(null);opener.current?.focus()},inspect=(events,button)=>{opener.current=button;setSelected(events)}
  useEffect(()=>{const node=lane.current;if(!node||typeof ResizeObserver==='undefined')return;const observer=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width>0)setLaneWidth(width)});observer.observe(node);return()=>observer.disconnect()},[scope,state.loading,state.data])
  const current=state.scope===scope?state:{loading:true},rows=current.data?.rows||[],groups=calendarGroups(rows,from,to,laneWidth)
  const err=(portfolio.invalidPortfolio?'This portfolio is unavailable.':null)||portfolio.error?.message||watchlist.error?.message||watchlist.error||current.error
  return <section className="intel-book-calendar border-y border-[var(--border-default)] py-4 space-y-3" aria-label="Book calendar"><div className="flex items-center gap-4 flex-wrap"><h2>{days===3?'Next 72 hours':`Next ${days} days`}</h2><label className="text-xs">Calendar window<select className="select ml-2" value={days} onChange={e=>{setDays(Number(e.target.value));setPage(0)}}><option value="3">72 hours</option><option value="7">7 days</option><option value="30">30 days</option></select></label><button className="intel-text-link" onClick={()=>{setNow(Date.now());setPage(0)}}>Refresh calendar</button><label className="text-xs flex gap-2"><input type="checkbox" checked={inactive} onChange={e=>{setInactive(e.target.checked);setPage(0)}}/>Show schedule changes</label></div><p className="text-xs text-[var(--fg-4)]">{asset?'This asset':'Selected portfolio and watchlist'} · market-wide events included · {cursor!=null?'As known at the saved cursor':'Stored source observations'}</p>
    {err?<p role="alert">Calendar coverage is unknown: {err}</p>:current.loading?<p role="status">Loading calendar evidence…</p>:<>
    {chartLane&&groups.length>0&&<div ref={lane} className="intel-calendar-lane" role="group" aria-label="Scheduled event lane, independent of price"><span className="intel-calendar-start">{stamp(from)}</span><span className="intel-calendar-end">{stamp(to)}</span>{groups.map(group=><button key={group.rows[0].event.id} style={{left:`${group.x}%`}} className="intel-calendar-tick" title={group.rows.map(row=>`${row.event.title} · ${stamp(row.time)} · ${row.event.event_status}`).join("; ")} aria-label={group.rows.map(row=>`${row.event.title} · ${stamp(row.time)} · ${row.event.event_status}`).join('; ')} onClick={e=>inspect(group.rows.map(row=>row.event),e.currentTarget)}>{group.rows.length>1?group.rows.length:'│'}</button>)}</div>}
    {!rows.length?<p>No matched scheduled events in this window. Source coverage may be incomplete.</p>:<ol className="intel-calendar-list">{rows.map(event=><li key={event.id}><button className="intel-text-link text-left" onClick={e=>inspect([event],e.currentTarget)}>{event.title}</button><time dateTime={event.scheduled_at||event.event_date}>{event.time_precision==='instant'?stamp(event.scheduled_at):`${event.event_date} · time not supplied`}</time><span>{event.event_status} · {event.relevance}{event.expires_at&&Date.parse(event.expires_at)<now?' · stale':''}</span></li>)}</ol>}
    {current.data?.unmatchedUnlocks>0&&<p className="text-xs" role="status">{current.data.unmatchedUnlocks} unlock records in this window lack verified asset identity and are excluded from personal matches.</p>}
    <nav className="flex gap-4" aria-label="Calendar pages">{page>0&&<button className="intel-text-link" onClick={()=>setPage(n=>n-1)}>Earlier events</button>}{current.data?.hasMore&&<button className="intel-text-link" onClick={()=>setPage(n=>n+1)}>Later events</button>}<Link className="intel-text-link" to="/intel/macro">Full market calendar</Link></nav></>}
    {selected&&<dialog ref={pane} className="intel-investigation intel-thread-inspector" aria-label="Calendar evidence" onCancel={e=>{e.preventDefault();close()}}><button className="btn btn--quiet" onClick={close}>Close</button>{selected.map(event=><CalendarEvidence key={event.id} event={event}/>)}</dialog>}
  </section>
}
